import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredDocuments } from '../../packages/apps/config.ts';

test('Feishu and Lark document readers use isolated account credentials and origins', async () => {
  const env = {
    BLAZAR_DOCS_ACCOUNT: 'Legacy',
    BLAZAR_DOCS_ACCESS_TOKEN: 'legacy',
    BLAZAR_DOCS_TOKEN_TEAM: 'team',
    BLAZAR_DOCS_TOKEN_PERSONAL: 'personal',
    BLAZAR_DOCS_TOKEN_GLOBAL: 'global',
    BLAZAR_FEISHU_DOCS: JSON.stringify([
      { account: 'Team', region: 'feishu', tokenEnv: 'BLAZAR_DOCS_TOKEN_TEAM' },
      { account: 'Personal', region: 'feishu', tokenEnv: 'BLAZAR_DOCS_TOKEN_PERSONAL' },
      { account: 'Team', region: 'lark', tokenEnv: 'BLAZAR_DOCS_TOKEN_GLOBAL' },
    ]),
  };
  const origins: string[] = [];
  const readers = configuredDocuments(env, async (url, options) => {
    origins.push(new URL(String(url)).origin);
    const auth = new Headers(options?.headers).get('Authorization');
    return Response.json({ code: 0, data: { content: auth } });
  });
  const docs = await Promise.all(readers.map(reader => reader.read('same-document', AbortSignal.timeout(1000))));
  assert.deepEqual(docs.map(doc => doc.text), ['Bearer legacy', 'Bearer team', 'Bearer personal', 'Bearer global']);
  assert.deepEqual(origins, [...Array(3).fill('https://open.feishu.cn'), 'https://open.larksuite.com']);
  assert.throws(() => configuredDocuments({ ...env, BLAZAR_DOCS_ACCOUNT: ' Team ' }), /Duplicate/);
  assert.throws(() => configuredDocuments({ ...env, BLAZAR_DOCS_TOKEN_TEAM: '' }), /Missing/);
});
