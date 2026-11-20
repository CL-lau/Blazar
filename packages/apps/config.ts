import type { DocumentConnector } from './documents.ts';
import { feishuDocuments } from './feishu-docs.ts';
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
  return [...readers.values()];
}
