import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { browserFormBackend } from '../../packages/apps/browser-actions.ts';

import { BrowserReceipts } from './browser-receipts.ts';

export function browserDeviceServer(config: {
  token: string; tool: string; receiptPath: string;
  form: Parameters<typeof browserFormBackend>[0];
}) {
  if (config.token.length < 32 || !/^[A-Za-z0-9_.-]{1,121}$/.test(config.tool)) {
    throw new Error('Set a strong device bearer token and a valid MCP tool name');
  }
  if (config.form.inputKey === 'blazarInvocationId') throw new Error('Reserved browser input key');
  const backend = browserFormBackend(config.form);
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const credential = digest('Bearer ' + config.token);
  const receipts = new BrowserReceipts(config.receiptPath);
  const statusTool = config.tool + '.status';
  const invocationKey = 'blazarInvocationId';
  const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  let busy = false;

  const server = createServer(async (request, response) => {
    if (request.url !== '/mcp' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    if (!timingSafeEqual(digest(request.headers.authorization ?? ''), credential)) {
      response.writeHead(401).end();
      return;
    }
    const mcp = new Server({ name: 'blazar-browser-device', version: '0.1.0' }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const disconnected = new AbortController();
    response.once('close', () => disconnected.abort());
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{
      name: config.tool, description: 'Submit the configured application form',
      inputSchema: { type: 'object', properties: {
        [config.form.inputKey]: { type: 'string', maxLength: 12_000 }, [invocationKey]: { type: 'string' },
      }, required: [config.form.inputKey, invocationKey], additionalProperties: false },
    }, {
      name: statusTool, description: 'Read the recorded outcome of a browser write',
      inputSchema: { type: 'object', properties: { [invocationKey]: { type: 'string' } },
        required: [invocationKey], additionalProperties: false },
    }] }));
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
      const input = params.arguments ?? {};
      const id = input[invocationKey];
      const failure = { isError: true, content: [{ type: 'text' as const, text: 'Browser write did not confirm success' }] };
      if (typeof id !== 'string' || !idPattern.test(id)) return failure;
      if (params.name === statusTool && Object.keys(input).length === 1) {
        const receipt = receipts.get(id);
        const resolution = receipt?.state === 'started' ? undefined : receipt?.state;
        return { content: [], structuredContent: {
          blazarInvocationId: id, resolution: resolution ?? 'unknown',
          ...(resolution && { evidence: resolution === 'applied'
            ? 'Browser device recorded a successful form response'
            : 'Browser device rejected the form before submission' }),
        } };
      }
      const value = input[config.form.inputKey];
      if (params.name !== config.tool || Object.keys(input).length !== 2 ||
          typeof value !== 'string' || value.length > 12_000) return failure;
      const fingerprint = digest(JSON.stringify([config.form, value])).toString('hex');
      const success = { content: [{ type: 'text' as const, text: 'Browser form confirmed the write' }] };
      const prior = receipts.get(id);
      if (prior) return prior.fingerprint === fingerprint && prior.state === 'applied' ? success : failure;
      if (busy || !receipts.claim(id, fingerprint)) return failure;
      busy = true;
      const active = AbortSignal.any([signal, disconnected.signal, AbortSignal.timeout(9_000)]);
      try {
        const result = await backend.invoke({
          connectionId: backend.connectionId, capability: backend.capability, invocationId: id, effect: 'write',
          input: { [config.form.inputKey]: value },
        }, active, async () => !active.aborted);
        if (result.status === 'denied') receipts.finish(id, 'not_applied');
        if (result.status !== 'succeeded') return failure;
        receipts.finish(id, 'applied');
        return success;
      } catch {
        return failure;
      } finally {
        busy = false;
      }
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
      else response.end();
    } finally {
      await mcp.close();
    }
  });
  server.once('close', () => receipts.close());
  return server;
}
