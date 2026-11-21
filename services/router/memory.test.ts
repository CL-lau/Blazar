import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MemoryStore } from './memory.ts';

test('workspace scope changes update the derived full-text index', t => {
  const directory = mkdtempSync(join(tmpdir(), 'blazar-memory-index-'));
  const path = join(directory, 'memory.sqlite');
  const store = new MemoryStore(path);
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  if (db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get()?.enabled !== 1) {
    return t.skip('SQLite does not include FTS5');
  }
  const connection = store.connect('owner', 'github', 'handbook');
  const source = { connection, resource: 'guide', revision: '1' };
  const older = store.remember('owner', 'one', 'alpha handbook', source)!;
  store.remember('owner', 'two', 'bravo handbook', source);
  const indexed = (term: string) =>
    db.prepare('SELECT rowid FROM memory_search WHERE memory_search MATCH ?').all(term).length;
  assert.equal(indexed('handbook'), 2);
  assert.equal(store.setConnectionWorkspace('owner', connection, 'two'), true);
  assert.equal(indexed('alpha'), 0);
  assert.equal(indexed('bravo'), 1);
  assert.equal(store.setConnectionWorkspace('owner', connection, null), true);
  assert.equal(indexed('handbook'), 2);
  assert.equal(store.disconnect('owner', connection), true);
  assert.equal(indexed('handbook'), 0);
  assert.equal(store.remove('owner', older), true);
  assert.equal(indexed('alpha'), 0);
});

test('recall respects workspace, source account, expiration and revocation', t => {
  const store = new MemoryStore(':memory:');
  t.after(() => store.close());
  const work = store.connect('owner', 'feishu', 'work account', 'project');
  const personal = store.connect('owner', 'feishu', 'personal account');
  const source = { connection: work, resource: 'review', revision: '1' };
  const document = store.remember('owner', 'project', '项目评审规范', source);
  assert.ok(document);
  assert.equal(store.remember('other', 'project', '项目评审规范', source), undefined);
  assert.equal(store.remember('owner', 'other', '项目评审规范', source), undefined);
  assert.equal(store.importDocument('owner', 'other', '项目评审规范', source), undefined);
  store.remember('owner', 'project', '旧评审规范', source, 1);
  store.remember('owner', 'project', '个人评审规范', { ...source, connection: personal });
  assert.equal(store.recall('owner', 'project', '评审规范', [work])[0]?.id, document);
  assert.equal(store.recall('owner', 'project', '评审规范', [work]).length, 1);
  assert.equal(store.recall('owner', 'project', '评审', [work]).length, 1);
  assert.equal(store.recall('owner', 'other', '评审规范', [work]).length, 0);
  assert.equal(store.recall('other', 'project', '评审规范', [work]).length, 0);
  assert.equal(store.recall('owner', 'project', '评审规范', []).length, 0);
  assert.equal(store.disconnect('other', work), false);
  assert.equal(store.disconnect('owner', work), true);
  assert.equal(store.recall('owner', 'project', '评审规范', [work]).length, 0);
  assert.equal(store.recall('owner', 'project', '评审规范', [personal]).length, 1);
  assert.equal(store.removeResource('owner', personal, 'review'), 1);
  assert.equal(store.recall('owner', 'project', '评审规范', [personal]).length, 0);
});

test('document corrections preserve imported identity and supersede the original search text', t => {
  const store = new MemoryStore(':memory:');
  t.after(() => store.close());
  const connection = store.connect('owner', 'github', 'handbook');
  const ref = { connection, resource: 'docs/guide.md', revision: 'original' };
  const id = store.importDocument('owner', 'project', 'Deprecated guidance', ref)!;
  assert.deepEqual(store.revise('other', id, 1, { body: 'Unauthorized' }), undefined);
  assert.deepEqual(store.revise('owner', id, 1, { body: 'Current guidance', pinned: true }), { version: 2, conflict: false });
  assert.equal(store.importDocument('owner', 'project', 'Deprecated guidance', ref), id);
  assert.equal(store.recall('owner', 'project', 'Deprecated', [connection]).length, 0);
  store.remember('owner', 'project', 'Other guidance');
  assert.equal(store.recall('owner', 'project', 'guidance', [connection])[0].id, id);
  assert.equal(store.remove('owner', id), true);
  assert.equal(store.recall('owner', 'project', 'Current', [connection]).length, 0);
});

test('source revocation removes every version and blocks a late import without affecting other resources', t => {
  const store = new MemoryStore(':memory:');
  t.after(() => store.close());
  const connection = store.connect('owner', 'feishu', 'team');
  const source = { connection, resource: 'document', revision: 'v1' };
  store.importDocument('owner', 'project', 'Confidential source text', source);
  store.importDocument('owner', 'other', 'Confidential source revision', { ...source, revision: 'v2' });
  store.importDocument('owner', 'project', 'Other source', { ...source, resource: 'second' });
  assert.equal(store.revokeResource('other', connection, source.resource), undefined);
  assert.equal(store.revokeResource('owner', connection, source.resource), 2);
  assert.equal(store.revokeResource('owner', connection, source.resource), 0);
  assert.equal(store.importDocument('owner', 'project', 'Late external response', source), undefined);
  assert.equal(store.remember('owner', 'project', 'Manual copy', source), undefined);
  assert.equal(store.recall('owner', 'project', 'Confidential', [connection]).length, 0);
  assert.equal(store.recall('owner', 'project', 'Other source', [connection]).length, 1);
});
