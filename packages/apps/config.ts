import { applicationWriteContract } from './action-contract.ts';
import { browserFormBackend } from './browser-actions.ts';
import { createHash } from 'node:crypto';
import { mcpActionBackend } from './mcp-actions.ts';
import { invokeApplicationAction, type ActionBackend, type ApplicationAction } from './actions.ts';
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
    const connectionId = JSON.stringify([entry.id, primary.account]);
    async function tryBackends<T>(
      capability: string,
      input: ApplicationAction['input'],
      signal: AbortSignal,
      invoke: (backend: typeof primary, index: number) => Promise<T>,
    ) {
      const action: ApplicationAction = {
        connectionId, capability, effect: 'read', invocationId: crypto.randomUUID(), input,
      };
      const candidates = backends.map((backend, index): ActionBackend<T> => ({
        id: String(index), connectionId, capability, effect: 'read',
        async invoke() {
          try {
            return { status: 'succeeded', output: await invoke(backend, index) };
          } catch (error) {
            if (!(error instanceof DocumentBackendUnavailable) || index === backends.length - 1) throw error;
            return { status: 'unavailable-before-dispatch' };
          }
        },
      }));
      const result = await invokeApplicationAction(action, candidates, async () => {
        // Only backends for this administrator-configured account reach this dispatcher.
        return true;
      }, signal);
      if (result.status === 'succeeded') return result.output;
      throw new DocumentUnavailable('No configured backend completed the document operation');
    }
    register({
      ...primary, app: entry.id, definition: { label, version: entry.version },
      read: (alias, signal) => tryBackends('document.read', { alias }, signal, async (reader, index) => {
        const backend: DocumentReadBackend = { kind: github && index === 0 ? 'github' : 'mcp', fallback: index > 0 };
        return { ...await reader.read(alias, signal), backend };
      }),
      health: signal => tryBackends('document.health', {}, signal, backend => backend.health(signal)),
      ...(!github && { discover: (signal: AbortSignal) => tryBackends('document.discover', {}, signal, backend => backend.discover!(signal)) }),
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

export function configuredApplicationWrites(env: NodeJS.ProcessEnv, transport = fetch) {
  const keys = new Set<string>();
  return entries(env, 'BLAZAR_MCP_ACTIONS').map(entry => {
    const { app, capability } = entry;
    const account = accountName(entry.account);
    if (typeof app !== 'string' || !/^(mcp|custom\.[a-z][a-z0-9-]{0,62})$/.test(app) ||
        typeof capability !== 'string' || !/^action\.[a-z0-9.-]{1,120}$/.test(capability)) {
      throw new Error('Invalid MCP application write configuration');
    }
    const contract = applicationWriteContract(entry);
    const key = JSON.stringify([app, account, capability]);
    if (keys.has(key)) throw new Error('Duplicate MCP application write capability');
    keys.add(key);
    const fallbacks = entry.fallbacks ?? [];
    if (!Array.isArray(fallbacks) || fallbacks.length > 2 || fallbacks.some(item =>
      !item || typeof item !== 'object' || Array.isArray(item) ||
      Object.keys(item).some(field => !['endpoint', 'tool', 'statusTool', 'tokenEnv', 'kind', 'url', 'submitUrl', 'button', 'inputLabel', 'inputKey', 'storageState'].includes(field)))) {
      throw new Error('Invalid MCP application write fallback configuration');
    }
    const candidates = [entry, ...fallbacks].map((candidate, index) => {
      if (candidate.kind === 'browser-form') {
        const { url, submitUrl, button, inputLabel, inputKey, storageState } = candidate;
        if (typeof url !== 'string' || typeof submitUrl !== 'string' || typeof button !== 'string' || !button.trim() ||
            typeof inputLabel !== 'string' || !inputLabel.trim() || typeof inputKey !== 'string' || !inputKey.trim() ||
            (storageState !== undefined && typeof storageState !== 'string')) {
          throw new Error('Invalid browser form configuration');
        }
        const backend = browserFormBackend({ id: 'browser-' + index, capability, url, submitUrl, button,
          inputLabel, inputKey, storageState });
        return { backend, lookup: undefined, identity: ['browser-form', url, submitUrl, button, inputLabel, inputKey, storageState] };
      }
      if (candidate.kind !== undefined && candidate.kind !== 'mcp') throw new Error('Unknown application write backend');
      const { endpoint, tool, statusTool, tokenEnv } = candidate;
      if (typeof endpoint !== 'string' || typeof tool !== 'string' ||
          (statusTool !== undefined && (typeof statusTool !== 'string' || statusTool === tool))) {
        throw new Error('Invalid MCP application write backend');
      }
      const token = tokenEnv === undefined ? undefined
        : accessToken(env, tokenEnv, /^BLAZAR_MCP_TOKEN_[A-Z0-9_]+$/);
      const binding = { id: index === 0 ? 'mcp' : 'mcp-' + index, connectionId: '', capability, endpoint, token };
      const backend = mcpActionBackend({ ...binding, effect: 'write', tool, includeInvocationId: Boolean(statusTool) }, transport);
      const lookup = typeof statusTool === 'string'
        ? mcpActionBackend({ ...binding, effect: 'read', tool: statusTool }, transport)
        : undefined;
      return { backend, lookup, identity: [new URL(endpoint).href, tool, statusTool, tokenEnv, token] };
    });
    const targets = candidates.map(({ backend, identity }) => JSON.stringify(backend.id.startsWith('browser-')
      ? identity : [identity[0], identity[1], identity[4]]));
    if (new Set(targets).size !== targets.length) throw new Error('Duplicate MCP application write backend');
    const fingerprint = candidates.length === 1 && !candidates[0].backend.id.startsWith('browser-')
      ? [key, entry.endpoint, entry.tool, entry.tokenEnv, candidates[0].identity[4], ...(entry.statusTool ? [entry.statusTool] : [])]
      : [key, candidates.map(item => item.identity)];
    if (contract) fingerprint.push(contract.definition);
    const revision = createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
    return { app, account, capability, revision, contract, candidates: candidates.map(({ backend, lookup }) => ({
      lookup,
      backend: contract ? {
        ...backend,
        async invoke(...args: Parameters<typeof backend.invoke>) {
          const result = await backend.invoke(...args);
          if (result.status === 'succeeded') {
            const value = backend.id.startsWith('browser-') ? result.output
              : (result.output as { structuredContent?: unknown } | undefined)?.structuredContent;
            if (!contract.acceptsOutput(value)) throw new Error('Application write did not return valid output evidence');
          }
          return result;
        },
      } : backend,
    })) };
  });
}

type ConfiguredWrite = ReturnType<typeof configuredApplicationWrites>[number];
export type ConfiguredApplicationWrite = Omit<ConfiguredWrite, 'contract'> & Partial<Pick<ConfiguredWrite, 'contract'>>;
