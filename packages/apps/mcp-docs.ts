import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DocumentAccessDenied, DocumentBackendUnavailable, DocumentUnavailable, documentText, type DocumentConnector } from './documents.ts';

export function mcpDocuments(account: string, rawEndpoint: string, resources: Record<string, unknown>,
                             token?: string, fetcher = fetch): DocumentConnector {
  const endpoint = new URL(rawEndpoint);
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search || (
    endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1')
  )) throw new Error('MCP document endpoint must use HTTPS or loopback HTTP');
  const entries = Object.entries(resources);
  if (!entries.length || entries.length > 200) throw new Error('Expected up to 200 MCP resource aliases');
  const byAlias = new Map<string, string>();
  for (const [alias, uri] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(alias) ||
        typeof uri !== 'string' || uri.length > 2_048 || !URL.canParse(uri)) {
      throw new Error('Invalid MCP resource alias or URI');
    }
    byAlias.set(alias, uri);
  }
  return {
    app: 'mcp', account, documentAliases: [...byAlias.keys()].sort(),
    accepts: alias => byAlias.has(alias),
    async read(alias, signal) {
      const uri = byAlias.get(alias);
      if (!uri) throw new DocumentUnavailable('Unknown MCP resource alias');
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { ...(token && { headers: { Authorization: 'Bearer ' + token } }), redirect: 'error' },
        fetch: async (input, init) => {
          const active = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
          const response = await fetcher(input, { ...init, redirect: 'error', signal: active });
          if (response.status === 401 || response.status === 403) {
            await response.body?.cancel();
            throw new DocumentAccessDenied('MCP server denied access for the configured account');
          }
          if ([502, 503, 504].includes(response.status)) {
            await response.body?.cancel();
            throw new DocumentBackendUnavailable('MCP document backend is temporarily unavailable');
          }
          if (!response.body) return response;
          let received = 0;
          const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              received += chunk.byteLength;
              if (received > 1_000_000) throw new DocumentUnavailable('MCP document response exceeds the import limit');
              controller.enqueue(chunk);
            },
          }));
          return new Response(body, { status: response.status, headers: response.headers });
        },
      });
      const client = new Client({ name: 'blazar', version: '0.1.0' });
      try {
        await client.connect(transport, { signal });
        const { contents } = await client.readResource({ uri }, { signal });
        const text = contents.flatMap(item => item.uri === uri && 'text' in item && typeof item.text === 'string'
          ? [item.text] : []).join('\n');
        return documentText(text);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof DocumentUnavailable) throw error;
        throw new DocumentUnavailable('MCP resource could not be read with the configured account');
      } finally {
        if (transport.sessionId && !signal.aborted) await transport.terminateSession().catch(() => {});
        await client.close();
      }
    },
  };
}
