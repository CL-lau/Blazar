import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { browserFormBackend } from '../../packages/apps/browser-actions.ts';

export function browserDeviceServer(config: {
  token: string; tool: string;
  form: Parameters<typeof browserFormBackend>[0];
}) {
  if (config.token.length < 32 || !/^[A-Za-z0-9_.-]{1,128}$/.test(config.tool)) {
    throw new Error('Set a strong device bearer token and a valid MCP tool name');
  }
  const backend = browserFormBackend(config.form);
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const credential = digest('Bearer ' + config.token);
  let busy = false;

  return createServer(async (request, response) => {
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
      inputSchema: { type: 'object', properties: { [config.form.inputKey]: { type: 'string', maxLength: 12_000 } },
        required: [config.form.inputKey], additionalProperties: false },
    }] }));
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
      const input = params.arguments ?? {};
      const value = input[config.form.inputKey];
      const failure = { isError: true, content: [{ type: 'text' as const, text: 'Browser write did not confirm success' }] };
      if (params.name !== config.tool || busy || Object.keys(input).length !== 1 ||
          typeof value !== 'string' || value.length > 12_000) return failure;
      busy = true;
      const active = AbortSignal.any([signal, disconnected.signal, AbortSignal.timeout(9_000)]);
      try {
        const result = await backend.invoke({
          connectionId: backend.connectionId, capability: backend.capability, invocationId: randomUUID(), effect: 'write', input,
        }, active, async () => !active.aborted);
        if (result.status !== 'succeeded') return failure;
        return { content: [{ type: 'text' as const, text: 'Browser form confirmed the write' }] };
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
}
