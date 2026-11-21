import { DocumentBackendUnavailable, DocumentUnavailable, type DocumentConnector, type DocumentReadBackend } from './documents.ts';
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
    if (entry.version !== 1 || (entry.connector !== 'mcp-resources' && entry.connector !== 'github-documents') || typeof entry.id !== 'string' ||
        !/^custom\.[a-z][a-z0-9-]{0,62}$/.test(entry.id) || typeof entry.label !== 'string' ||
        !entry.label.trim() || entry.label.length > 128 || /[\x00-\x1f\x7f]/.test(entry.label)) {
      throw new Error('Invalid application manifest with version 1');
    }
    const label = entry.label.trim();
    const previousLabel = customLabels.get(entry.id);
    if (previousLabel !== undefined && previousLabel !== label) throw new Error('Conflicting application manifest labels');
    customLabels.set(entry.id, label);
    const github = entry.connector === 'github-documents';
    const primary = github ? githubManifestReader(entry, env, transport) : mcpReader(entry);
    const fallbacks = entry.fallbacks ?? [];
    if (!Array.isArray(fallbacks) || fallbacks.length > 2 || fallbacks.some(backend =>
      !backend || typeof backend !== 'object' || Array.isArray(backend) ||
      Object.keys(backend).some(key => key !== 'endpoint' && key !== 'tokenEnv' && !(github && key === 'resources')))) {
      throw new Error('Invalid MCP fallback backends');
    }
    const backups = fallbacks.map(backend => mcpReader({
      ...backend, account: entry.account, resources: github ? backend.resources : entry.resources,
    }));
    if (github && backups.some(backend => JSON.stringify(backend.documentAliases) !== JSON.stringify(primary.documentAliases))) {
      throw new Error('Each fallback must map exactly the configured document aliases');
    }
    const backends = [primary, ...backups];
    async function tryBackends<T>(signal: AbortSignal, invoke: (backend: typeof primary, index: number) => Promise<T>) {
      for (const [index, backend] of backends.slice(0, -1).entries()) {
        signal.throwIfAborted();
        try {
          return await invoke(backend, index);
        } catch (error) {
          if (!(error instanceof DocumentBackendUnavailable)) throw error;
        }
      }
      signal.throwIfAborted();
      return invoke(backends[backends.length - 1], backends.length - 1);
    }
    register({
      ...primary, app: entry.id, definition: { label, version: entry.version },
      read: (alias, signal) => tryBackends(signal, async (reader, index) => {
        const backend: DocumentReadBackend = { kind: github && index === 0 ? 'github' : 'mcp', fallback: index > 0 };
        return { ...await reader.read(alias, signal), backend };
      }),
      health: signal => tryBackends(signal, backend => backend.health(signal)),
      ...(!github && { discover: (signal: AbortSignal) => tryBackends(signal, backend => backend.discover!(signal)) }),
    });
  }
  return [...readers.values()];
}

function githubManifestReader(entry: Record<string, unknown>, env: NodeJS.ProcessEnv, transport: typeof fetch) {
  if (typeof entry.repository !== 'string') throw new Error('Expected GitHub document repository');
  const token = accessToken(env, entry.tokenEnv, /^BLAZAR_GITHUB_TOKEN_[A-Z0-9_]+$/);
  const reader = githubDocuments(accountName(entry.account), entry.repository, token, transport);
  const raw = entry.documents;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected a GitHub document alias map');
  const documents = new Map<string, string>();
  for (const [alias, path] of Object.entries(raw)) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(alias) || typeof path !== 'string' || !reader.accepts(path)) {
      throw new Error('Invalid GitHub document alias or path');
    }
    documents.set(alias, path);
  }
  if (!documents.size || documents.size > 100) throw new Error('Configure 1 to 100 GitHub document aliases');
  return {
    ...reader,
    documentAliases: [...documents.keys()].sort(),
    accepts: (alias: string) => documents.has(alias),
    read(alias: string, signal: AbortSignal) {
      const path = documents.get(alias);
      if (!path) throw new DocumentUnavailable('Unknown GitHub document alias');
      return reader.read(path, signal);
    },
  };
}
