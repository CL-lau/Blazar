import { mcpClient } from './mcp-client.ts';
import { DocumentUnavailable, documentText, type DocumentConnector } from './documents.ts';

export function mcpDocuments(account: string, rawEndpoint: string, resources: Record<string, unknown>,
                             token?: string, fetcher = fetch): DocumentConnector & Required<Pick<DocumentConnector, 'discover' | 'health'>> {
  const connect = mcpClient(rawEndpoint, token, fetcher);
  const withClient: typeof connect = async (signal, operation) => {
    try {
      return await connect(signal, operation);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof DocumentUnavailable) throw error;
      throw new DocumentUnavailable('MCP resources could not be accessed with the configured account');
    }
  };
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
      return withClient(signal, async client => {
        const { contents } = await client.readResource({ uri }, { signal });
        const text = contents.flatMap(item => item.uri === uri && 'text' in item && typeof item.text === 'string'
          ? [item.text] : []).join('\n');
        return documentText(text);
      });
    },
    async health(signal) {
      await withClient(signal, client => client.listResources(undefined, { signal }));
    },
    discover(signal) {
      return withClient(signal, async client => {
        const allowed = new Set(byAlias.values());
        const found = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 5; page++) {
          const result = await client.listResources(cursor ? { cursor } : undefined, { signal });
          for (const resource of result.resources) if (allowed.has(resource.uri)) found.add(resource.uri);
          cursor = result.nextCursor;
          if (!cursor || found.size === allowed.size) break;
        }
        return {
          aliases: [...byAlias].filter(([, uri]) => found.has(uri)).map(([alias]) => alias).sort(),
          complete: !cursor || found.size === allowed.size,
        };
      });
    },
  };
}
