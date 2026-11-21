import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DocumentAccessDenied, DocumentBackendUnavailable, DocumentUnavailable } from './documents.ts';

export function mcpClient(rawEndpoint: string, token?: string, fetcher = fetch) {
  const endpoint = new URL(rawEndpoint);
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search || (
    endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1')
  )) throw new Error('MCP endpoint must use HTTPS or loopback HTTP');
  return async function withClient<T>(signal: AbortSignal, operation: (client: Client) => Promise<T>) {
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
      return await operation(client);
    } finally {
      if (transport.sessionId && !signal.aborted) await transport.terminateSession().catch(() => {});
      await client.close();
    }
  };
}
