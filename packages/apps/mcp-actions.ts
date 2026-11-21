import type { ActionBackend } from './actions.ts';
import { DocumentAccessDenied, DocumentBackendUnavailable } from './documents.ts';
import { mcpClient } from './mcp-client.ts';

type McpActionConfig = Pick<ActionBackend, 'id' | 'connectionId' | 'capability' | 'effect'> & {
  endpoint: string;
  tool: string;
  token?: string;
};

export function mcpActionBackend(config: McpActionConfig, fetcher = fetch): ActionBackend {
  const { id, connectionId, capability, effect, endpoint, tool, token } = config;
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool)) throw new Error('Invalid configured MCP tool name');
  const connect = mcpClient(endpoint, token, fetcher);
  return {
    id, connectionId, capability, effect,
    async invoke(action, signal, authorizeDispatch) {
      let dispatched = false;
      try {
        return await connect(signal, async client => {
          signal.throwIfAborted();
          if (!client.getServerCapabilities()?.tools) return { status: 'unavailable-before-dispatch' };
          if (!await authorizeDispatch()) return { status: 'denied' };
          signal.throwIfAborted();
          dispatched = true;
          const result = await client.callTool({ name: tool, arguments: { ...action.input } }, undefined, { signal });
          if (result.isError) throw new Error('MCP tool reported a failure');
          return { status: 'succeeded', output: result };
        });
      } catch (error) {
        // A transport error after tools/call starts says nothing about the external effect.
        if (!dispatched && error instanceof DocumentBackendUnavailable) return { status: 'unavailable-before-dispatch' };
        if (!dispatched && error instanceof DocumentAccessDenied) return { status: 'denied' };
        throw error;
      }
    },
  };
}
