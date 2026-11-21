import { requestMemoryDraft } from './application/memory-draft.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MemoryStore } from './memory.ts';

test('document sync resumes its saved cursor and rejects stale schedule leases after restart', t => {
  const root = mkdtempSync(join(tmpdir(), 'blazar-document-sync-'));
  const path = join(root, 'sync.sqlite');
  let store = new MemoryStore(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const connection = store.connect('owner', 'github', 'handbook', 'work');
  assert.equal(store.setDocumentSync('owner', connection, 'work', 15, 100), true);
  const first = store.leaseDocumentSync(100)!;
  assert.equal(first.cursor, '');
  store.finishDocumentSync(first, 'guide.md', 110);
  store.close();
  store = new MemoryStore(path);
  const next = store.leaseDocumentSync(110)!;
  assert.equal(next.cursor, 'guide.md');
  assert.equal(store.documentSyncActive(first, 110), false);
  assert.equal(store.documentSyncActive(next, 110), true);
  assert.equal(store.setConnectionWorkspace('owner', connection, 'private'), true);
  assert.equal(store.documentSyncActive(next, 110), false);
  store.finishDocumentSync(next, 'skip.md', 111);
  assert.equal(store.setConnectionWorkspace('owner', connection, 'work'), true);
  assert.equal(store.documentSyncActive(next, 111), false);
  const restored = store.leaseDocumentSync(111)!;
  assert.equal(restored.cursor, 'guide.md');
  assert.equal(store.setConnectionWorkspace('owner', connection, 'work'), true);
  assert.equal(store.documentSyncActive(restored, 111), true);
  store.finishDocumentSync(restored, 'expired.md', 45_112);
  assert.equal(store.leaseDocumentSync(45_112)?.cursor, 'guide.md');
});

test('personal context finds unpinned Chinese preferences in a longer sentence', t => {
  const store = new MemoryStore(':memory:');
  t.after(() => store.close());
  const match = store.remember('owner', 'project', '评审使用表格展示风险。');
  store.remember('owner', 'private', '评审报告留在私人项目。');
  const imported = store.connect('owner', 'feishu', 'review');
  store.remember('owner', 'project', '团队评审使用文档。', { connection: imported, resource: 'guide', revision: '1' });
  const hidden = store.remember('owner', 'project', '评审请用幻灯片。')!;
  store.revise('owner', hidden, 1, { disabled: true });
  assert.deepEqual(store.personalContext('owner', 'project', '下次评审报告请用表格汇总').map(note => note.id), [match]);
});

test('memory recall matches separated Chinese keywords within the authorized workspace and sources', t => {
  const store = new MemoryStore(':memory:');
  t.after(() => store.close());
  const feishu = store.connect('owner', 'feishu', 'review', 'team');
  const github = store.connect('owner', 'github', 'handbook');
  const write = (owner: string, workspace: string, connection: string, resource: string, body: string) =>
    store.importDocument(owner, workspace, body, { connection, resource, revision: '1' });
  const first = write('owner', 'team', feishu, 'review', '评审时请逐项列出交付风险。');
  const second = write('owner', 'team', github, 'guide', '所有风险须在发布评审中汇报。');
  write('owner', 'team', github, 'different', '交付评审需要记录会议结论。');
  write('owner', 'private', github, 'private', '项目评审包含风险说明。');
  const unrelated = store.connect('other', 'github', 'other');
  write('other', 'team', unrelated, 'another', '评审里有风险说明。');
  const recalls = (query: string, sources: string[]) => store.recall('owner', 'team', query, sources, false, false).map(item => item.id);
  assert.deepEqual(new Set(recalls('评审 风险', [feishu, github])), new Set([first, second]));
  assert.deepEqual(recalls('发布评审 风险', [github]), [second]);
  assert.deepEqual(recalls('评审 风险', [feishu]), [first]);
  assert.equal(store.disconnect('owner', feishu), true);
  assert.deepEqual(recalls('评审 风险', [feishu, github]), [second]);
});

test('expired memory cleanup removes bounded batches and clears derived indexes and revisions', t => {
  const root = mkdtempSync(join(tmpdir(), 'blazar-memory-expiry-'));
  const path = join(root, 'memory.sqlite');
  const store = new MemoryStore(path);
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const now = Date.now();
  const expired = store.remember('owner', 'work', 'First forecast', undefined, now + 10_000)!;
  assert.deepEqual(store.revise('owner', expired, 1, { body: 'Updated forecast' })?.version, 2);
  const connection = store.connect('owner', 'github', 'guide', 'work');
  const source = store.remember('owner', 'work', 'Source forecast', { connection, resource: 'guide', revision: '1' }, now + 20_000)!;
  const permanent = store.remember('owner', 'work', 'Permanent forecast')!;
  const future = store.remember('owner', 'work', 'Future forecast', undefined, now + 60_000)!;
  const past = store.remember('owner', 'work', 'Already expired', undefined, now - 1)!;
  assert.equal(store.resolvePersonalEvidence('owner', 'work', [{ id: past, version: 1 }]), undefined);
  assert.equal(store.resolvePersonalEvidence('owner', 'work', [{ id: expired, version: 1 }]), undefined);
  assert.equal(store.resolvePersonalEvidence('owner', 'work', [{ id: expired, version: 2 }])?.[0].body, 'Updated forecast');
  assert.equal(store.pruneExpired(now, 1), 1);
  assert.equal(store.pruneExpired(now + 20_000, 1), 1);
  assert.equal(db.prepare('SELECT 1 FROM memory_revision WHERE id=?').get(expired), undefined);
  assert.ok(db.prepare('SELECT 1 FROM memory WHERE id=?').get(source));
  assert.equal(store.pruneExpired(now + 20_000, 1), 1);
  assert.equal(store.pruneExpired(now + 20_000, 1), 0);
  assert.deepEqual(new Set(store.recall('owner', 'work', 'forecast', [connection]).map(item => item.id)),
    new Set([permanent, future]));
  if (db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get()?.enabled === 1) {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_search WHERE memory_search MATCH 'forecast'").get()?.count, 2);
  }
});

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
  store.recordDocumentAccess(connection, source.resource, 1, false);
  assert.equal(indexed('handbook'), 0);
  assert.equal(store.setConnectionWorkspace('owner', connection, 'two'), true);
  assert.equal(indexed('alpha'), 0);
  assert.equal(indexed('bravo'), 0);
  store.recordDocumentAccess(connection, source.resource, 2, true);
  assert.equal(indexed('alpha'), 0);
  assert.equal(indexed('bravo'), 1);
  assert.equal(store.setConnectionWorkspace('owner', connection, null), true);
  assert.equal(indexed('handbook'), 2);
  store.recordDocumentAccess(connection, source.resource, 3, false);
  assert.equal(indexed('handbook'), 0);
  assert.equal(store.disconnect('owner', connection), true);
  store.recordDocumentAccess(connection, source.resource, 4, true);
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

test('a delayed document import cannot replace the newer revision in recall', t => {
  const store = new MemoryStore(':memory:');
  t.after(() => store.close());
  const connection = store.connect('owner', 'github', 'handbook');
  const source = { connection, resource: 'review.md' };
  const latest = store.importDocument('owner', 'project', 'Current review template', { ...source, revision: 'v2' }, 2);
  const earlier = store.importDocument('owner', 'project', 'Outdated review template', { ...source, revision: 'v1' }, 1);
  assert.ok(latest && earlier && latest !== earlier);
  assert.deepEqual(store.recall('owner', 'project', 'review', [connection]).map(row => row.id), [latest]);
  assert.equal(store.recall('owner', 'project', 'Outdated', [connection]).length, 0);
  store.recordDocumentAccess(connection, source.resource, 1, false);
  assert.equal(store.recall('owner', 'project', 'review', [connection])[0]?.id, latest);
  store.recordDocumentAccess(connection, source.resource, 3, false);
  assert.equal(store.importDocument('owner', 'project', 'Current review template', { ...source, revision: 'v2' }, 2), undefined);
  assert.equal(store.recall('owner', 'project', 'review', [connection]).length, 0);
  assert.equal(store.importDocument('owner', 'project', 'Current review template', { ...source, revision: 'v2' }, 4), latest);
  assert.equal(store.remove('owner', latest), true);
  assert.equal(store.recall('owner', 'project', 'review', [connection]).length, 0);
  assert.equal(store.revokeResource('owner', connection, source.resource), 1);
});

test('confirming a derived memory rechecks the evidence version and inherits source access', t => {
  const store = new MemoryStore(':memory:');
  t.after(() => store.close());
  const connection = store.connect('owner', 'github', 'workspace repository', 'project');
  const source = { connection, resource: 'docs/review.md', revision: 'commit-one' };
  const original = store.remember('owner', 'project', 'The source document describes the review.', source)!;
  const body = 'Use three review bullets.';
  assert.equal(store.rememberFromEvidence('another', 'project', original, 1, body), undefined);
  assert.equal(store.rememberFromEvidence('owner', 'other-workspace', original, 1, body), undefined);
  assert.equal(store.revise('owner', original, 1, { body: 'The document describes the revised review.' })?.version, 2);
  assert.equal(store.rememberFromEvidence('owner', 'project', original, 1, body), undefined);
  const id = store.rememberFromEvidence('owner', 'project', original, 2, body);
  assert.ok(id);
  assert.equal(store.rememberFromEvidence('owner', 'project', original, 2, body), id);
  const recalled = store.recall('owner', 'project', 'three review bullets', [connection]);
  assert.equal(recalled[0].id, id);
  assert.equal(recalled[0].resource, source.resource);
  assert.equal(recalled[0].revision, source.revision);
  assert.deepEqual({ ...store.history('owner', id)?.derivedFrom }, { id: original, version: 2 });
  const descendant = store.rememberFromEvidence('owner', 'project', id, 1, 'Latest review procedure')!;
  assert.ok(descendant);
  assert.equal(store.revise('owner', original, 2, { body: 'The review procedure has changed.' })?.version, 3);
  assert.deepEqual(store.recall('owner', 'project', 'three review bullets', [connection]), []);
  assert.deepEqual(store.recall('owner', 'project', 'Latest review procedure', [connection]), []);
  assert.equal(store.resolveAppEvidence('owner', 'project', [{ id: descendant, version: 1 }]), undefined);
  assert.ok(store.revokeResource('owner', connection, source.resource));
  assert.deepEqual(store.recall('owner', 'project', 'three review bullets', [connection]), []);
  assert.equal(store.rememberFromEvidence('owner', 'project', original, 2, body), undefined);
});

test('memory drafting discards output if the connection is revoked during generation', async t => {
  const store = new MemoryStore(':memory:');
  t.after(() => store.close());
  const connection = store.connect('owner', 'github', 'repository', 'project');
  const id = store.remember('owner', 'project', 'Review decisions', {
    connection, resource: 'docs/review.md', revision: 'first',
  })!;
  await assert.rejects(requestMemoryDraft(store, async () => {
    assert.equal(store.setConnectionWorkspace('owner', connection, 'other'), true);
    assert.equal(store.setConnectionWorkspace('owner', connection, 'project'), true);
    return 'A proposed memory.';
  }, 'owner', 'project', { id, version: 1 }), /Source memory changed while drafting/);
  assert.deepEqual(await requestMemoryDraft(store, async () => 'A fresh draft.', 'owner', 'project', { id, version: 1 }),
    { body: 'A fresh draft.' });
  await assert.rejects(requestMemoryDraft(store, async evidence => {
    assert.equal(evidence, 'Review decisions');
    store.disconnect('owner', connection);
    return 'A proposed memory.';
  }, 'owner', 'project', { id, version: 1 }), /Source memory changed while drafting/);
  assert.deepEqual(store.recall('owner', 'project', 'proposed memory', [connection]), []);
});

test('moving a connection away and back invalidates document reads already in flight', async t => {
  const { invokeDocumentCapability } = await import('./application/document-sync.ts');
  const store = new MemoryStore(':memory:');
  t.after(() => store.close());
  const connection = store.connect('owner', 'github', 'handbook', 'project');
  const read = Promise.withResolvers<{ text: string; revision: string }>();
  const reader = { app: 'github', account: 'handbook', accepts: () => true, read: () => read.promise };

  const importing = invokeDocumentCapability(store, 'owner', connection, [reader], 'document.import',
    { workspace: 'project', document: 'review.md' });
  assert.equal(store.setConnectionWorkspace('owner', connection, 'other'), true);
  assert.equal(store.setConnectionWorkspace('owner', connection, 'project'), true);
  read.resolve({ text: 'Draft review template', revision: 'v1' });
  await assert.rejects(importing, /Source access changed during the document read/);
  assert.deepEqual(store.recall('owner', 'project', 'review', [connection]), []);
  await invokeDocumentCapability(store, 'owner', connection, [reader], 'document.import',
    { workspace: 'project', document: 'review.md' });
  assert.equal(store.recall('owner', 'project', 'review', [connection]).length, 1);
});

test('manual document refresh discards page results when the source scope changes', async t => {
  const { invokeDocumentCapability } = await import('./application/document-sync.ts');
  const store = new MemoryStore(':memory:');
  t.after(() => store.close());
  const connection = store.connect('owner', 'github', 'handbook', 'project');
  const source = { connection, resource: 'review.md', revision: 'v1' };
  store.importDocument('owner', 'project', 'Current review template', source);
  const read = Promise.withResolvers<{ text: string; revision: string }>();
  const reader = { app: 'github', account: 'handbook', accepts: () => true, read: () => read.promise };
  const refresh = () => invokeDocumentCapability(store, 'owner', connection, [reader], 'document.refresh', { workspace: 'project' });
  const stale = refresh();
  store.setConnectionWorkspace('owner', connection, 'private');
  store.setConnectionWorkspace('owner', connection, 'project');
  read.resolve({ text: 'New review template', revision: 'v2' });
  await assert.rejects(stale, /Source access changed during refresh/);
  assert.equal(store.recall('owner', 'project', 'review', [connection])[0]?.revision, 'v1');
  assert.deepEqual(await refresh(), { refreshed: 1, unavailable: 0, after: null });
  assert.equal(store.recall('owner', 'project', 'review', [connection])[0]?.revision, 'v2');
});

test('a delayed document preview cannot return text after a newer source denial', async t => {
  const { invokeDocumentCapability } = await import('./application/document-sync.ts');
  const { DocumentAccessDenied } = await import('../../packages/apps/documents.ts');
  const store = new MemoryStore(':memory:');
  t.after(() => store.close());
  const connection = store.connect('owner', 'github', 'handbook', 'project');
  const pending = Promise.withResolvers<{ text: string; revision: string }>();
  const input = { workspace: 'project', document: 'review.md' };
  const reader = { app: 'github', account: 'handbook', accepts: () => true, read: () => pending.promise };
  const preview = invokeDocumentCapability(store, 'owner', connection, [reader], 'document.read', input);
  const denied = { ...reader, async read() { throw new DocumentAccessDenied('Access revoked'); } };
  await assert.rejects(invokeDocumentCapability(store, 'owner', connection, [denied], 'document.test', input), /Access revoked/);
  pending.resolve({ text: 'Private review', revision: 'v1' });
  await assert.rejects(preview, /Source access changed during the document read/);
  assert.deepEqual(store.recall('owner', 'project', 'review', [connection]), []);
});
