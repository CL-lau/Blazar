import { DocumentBackendUnavailable, type DocumentConnector } from './documents.ts';
import { feishuDocuments } from './feishu-docs.ts';
import { mcpDocuments } from './mcp-docs.ts';
import { githubDocuments } from './github-docs.ts';

function entries(env: NodeJS.ProcessEnv, key: string): Record<string, unknown>[] {
  let list: unknown;
  try { list = JSON.parse(env[key] ?? '[]'); }
  catch { throw new Error(key + ' must contain a JSON array'); }
  if (!Array.isArray(list) || list.length > 50 ||
      list.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw new Error(key + ' must contain up to 50 account entries');
  }
  return list;
}

function accountName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 256) {
    throw new Error('Invalid document account label');
  }
  return value.trim();
}

function accessToken(env: NodeJS.ProcessEnv, name: unknown, prefix: RegExp) {
  if (typeof name !== 'string' || !prefix.test(name)) throw new Error('Invalid document credential variable name');
  const token = env[name];
  if (!token?.trim()) throw new Error('Missing document account credential');
  return token;
}

export function configuredDocuments(env: NodeJS.ProcessEnv, transport = fetch): DocumentConnector[] {
  const readers = new Map<string, DocumentConnector>();
  const register = (reader: DocumentConnector) => {
    const key = JSON.stringify([reader.app, reader.account]);
    if (readers.has(key)) throw new Error('Duplicate document account label for this application');
    readers.set(key, reader);
  };
  const legacyToken = env.BLAZAR_DOCS_ACCESS_TOKEN;
  const legacyAccount = env.BLAZAR_DOCS_ACCOUNT;
  if (Boolean(legacyToken) !== Boolean(legacyAccount)) throw new Error('Set both Blazar document connection values');
  if (legacyToken && legacyAccount) {
    register(feishuDocuments(env.BLAZAR_DOCS_REGION === 'lark' ? 'lark' : 'feishu',
      accountName(legacyAccount), legacyToken, transport));
  }
  for (const entry of entries(env, 'BLAZAR_FEISHU_DOCS')) {
    if (entry.region !== 'feishu' && entry.region !== 'lark') throw new Error('Expected document region feishu or lark');
    const token = accessToken(env, entry.tokenEnv, /^BLAZAR_DOCS_TOKEN_[A-Z0-9_]+$/);
    register(feishuDocuments(entry.region, accountName(entry.account), token, transport));
  }
  for (const entry of entries(env, 'BLAZAR_GITHUB_DOCS')) {
    if (typeof entry.repository !== 'string') throw new Error('Expected GitHub document repository');
    const token = accessToken(env, entry.tokenEnv, /^BLAZAR_GITHUB_TOKEN_[A-Z0-9_]+$/);
    register(githubDocuments(accountName(entry.account), entry.repository, token, transport));
  }
  const mcpReader = (entry: Record<string, unknown>) => {
    if (typeof entry.endpoint !== 'string' || !entry.resources ||
        typeof entry.resources !== 'object' || Array.isArray(entry.resources)) {
      throw new Error('Expected an MCP endpoint and a resource alias map');
    }
    const token = entry.tokenEnv === undefined ? undefined
      : accessToken(env, entry.tokenEnv, /^BLAZAR_MCP_TOKEN_[A-Z0-9_]+$/);
    return mcpDocuments(accountName(entry.account), entry.endpoint, entry.resources as Record<string, unknown>, token, transport);
  };
  for (const entry of entries(env, 'BLAZAR_MCP_DOCS')) register(mcpReader(entry));
  const customLabels = new Map<string, string>();
  for (const entry of entries(env, 'BLAZAR_APP_MANIFESTS')) {
    if (entry.version !== 1 || entry.connector !== 'mcp-resources' || typeof entry.id !== 'string' ||
        !/^custom\.[a-z][a-z0-9-]{0,62}$/.test(entry.id) || typeof entry.label !== 'string' ||
        !entry.label.trim() || entry.label.length > 128 || /[\x00-\x1f\x7f]/.test(entry.label)) {
      throw new Error('Invalid application manifest with version 1');
    }
    const label = entry.label.trim();
    const previousLabel = customLabels.get(entry.id);
    if (previousLabel !== undefined && previousLabel !== label) throw new Error('Conflicting application manifest labels');
    customLabels.set(entry.id, label);
    const primary = mcpReader(entry);
    const fallbacks = entry.fallbacks ?? [];
    if (!Array.isArray(fallbacks) || fallbacks.length > 2 || fallbacks.some(backend =>
      !backend || typeof backend !== 'object' || Array.isArray(backend) ||
      Object.keys(backend).some(key => key !== 'endpoint' && key !== 'tokenEnv'))) {
      throw new Error('Invalid MCP fallback backends');
    }
    const backends = [primary, ...fallbacks.map(backend =>
      mcpReader({ ...backend, account: entry.account, resources: entry.resources }))];
    register({
      ...primary, app: entry.id, definition: { label, version: entry.version },
      async read(alias, signal) {
        for (const backend of backends.slice(0, -1)) {
          signal.throwIfAborted();
          try {
            return await backend.read(alias, signal);
          } catch (error) {
            if (!(error instanceof DocumentBackendUnavailable)) throw error;
          }
        }
        signal.throwIfAborted();
        return backends[backends.length - 1].read(alias, signal);
      },
    });
  }
  return [...readers.values()];
}
