import { githubDocuments } from '../../packages/apps/github-docs.ts';
import { feishuDocuments } from '../../packages/apps/feishu-docs.ts';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceLedger } from '../device/ledger.ts';
import { DeviceClient } from '../device/client.ts';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { routerServer } from './http.ts';
import { runDueDocumentSync } from './application/document-sync.ts';
import { MemoryStore } from './memory.ts';
import { TaskStore } from './store.ts';

test('Router authenticates, deduplicates commands and replays task changes over HTTP', async t => {
  const store = new TaskStore(':memory:');
  const memory = new MemoryStore(':memory:');
  const token = 'local-test-secret';
  let decisions = 0;
  let memoryAnswers = 0;
  let routingMemory: string[] | undefined;
  let routingMemoryId: string | undefined;
  let revokeDuringAnswer: string | undefined;
  let githubStatus = 200;
  let githubBody = 'Engineering review findings';
  const answerStarted = Promise.withResolvers<void>();
  const answerCancelled = Promise.withResolvers<void>();
  const server = routerServer(store, {
    owner: 'test', token, memory, pushEnabled: true,
    documents: [feishuDocuments('feishu', 'project account', 'fixture', async (url, init) => {
      assert.equal(String(url), 'https://open.feishu.cn/open-apis/docx/v1/documents/doc123/raw_content');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture');
      return Response.json({ code: 0, data: { content: 'Design review findings' } });
    }), githubDocuments('engineering', 'example/handbook', 'other-fixture', async (url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer other-fixture');
      if (String(url) === 'https://api.github.com/repos/example/handbook') {
        return new Response(githubStatus === 200 ? '{}' : null, { status: githubStatus });
      }
      assert.match(String(url), /^https:\/\/api\.github\.com\/repos\/example\/handbook\/contents\/docs\/(review|other)\.md$/);
      return new Response(githubStatus === 200 ? githubBody : null, { status: githubStatus });
    })],
    async draftMemory(evidence) {
      assert.equal(evidence, 'Design review findings');
      return 'Keep one review summary.';
    },
    async answerMemory(question, evidence, signal) {
      if (question === 'Cancel selected document answer') {
        answerStarted.resolve();
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            answerCancelled.resolve();
            reject(signal.reason);
          }, { once: true });
        });
      }
      if (question === 'Compare selected documents') {
        assert.deepEqual(evidence.map(item => item.resource), ['doc123', 'docs/review.md']);
        assert.deepEqual(evidence.map(item => item.body), ['Design review findings', 'Engineering review findings']);
        return 'Both documents contain review findings.';
      }
      memoryAnswers++;
      assert.equal(evidence[0].resource, 'doc123');
      assert.equal(evidence[0].body, 'Design review findings');
      if (question === 'Move now' && revokeDuringAnswer) {
        memory.setConnectionWorkspace('test', revokeDuringAnswer, 'other');
        memory.setConnectionWorkspace('test', revokeDuringAnswer, 'demo');
      }
      if (question === 'Revoke now' && revokeDuringAnswer) memory.disconnect('test', revokeDuringAnswer);
      return 'The document contains design review findings.';
    },
    async harness(input, _signal, reportUsage) {
      reportUsage?.({ input: 10, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 16 });
      decisions++;
      if (input.text === 'Add tests to the review') {
        const [task] = input.findTasks!('Draft the review');
        return { kind: 'append_task', taskId: task.id, text: 'Add test coverage.', instruction: 'Include tests.' };
      }
      if (input.workspace === 'memory-review') {
        routingMemory = input.personalMemory;
        if (routingMemoryId) memory.remove('test', routingMemoryId);
        return { kind: 'reply', text: 'Reviewed workspace preferences.' };
      }
      if (input.text === 'Plan the review') return {
        kind: 'propose_workflow', text: 'Draft and review',
        steps: [{ key: 'draft', goal: 'Draft notes', needs: [] },
                { key: 'review', goal: 'Review notes', needs: ['draft'] }],
      };
      if (input.text === 'The design project') {
        assert.deepEqual(input.recent, [{ text: 'Could you help?', decision: { kind: 'clarify', text: 'Which project?' } }]);
        return { kind: 'create_task', goal: 'Help with the design project' };
      }
      return input.text.endsWith('?') ? { kind: 'clarify', text: 'Which project?' } : { kind: 'create_task' };
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>(resolve => {
      server.closeDeviceSockets();
      server.close(() => resolve());
      server.closeAllConnections();
    });
    memory.close();
    store.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const health = await fetch(url + '/v1/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { service: 'blazar-router', status: 'ready' });
  assert.equal((await fetch(url + '/v1/health', { headers: { 'X-Blazar-Public-Gateway': '1' } })).status, 404);
  assert.equal((await fetch(url + '/v1/health?redirect=1')).status, 401);
  const headers = { Authorization: `Bearer ${token}` };
  const post = (path: string, key: string, data: object) => fetch(url + path, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(data),
  });

  assert.equal((await fetch(url + '/v1/state')).status, 401);
  const creation = await post('/v1/events', 'create', { workspace: 'demo', text: 'Summarize notes' });
  assert.equal(creation.status, 202);
  const task = await creation.json();
  const repeated = await post('/v1/events', 'create', { workspace: 'demo', text: 'Summarize notes' });
  assert.equal((await repeated.json()).id, task.id);
  const snapshot = await (await fetch(url + '/v1/state', { headers })).json();
  assert.equal(snapshot.tasks.length, 1);

  const path = `/v1/tasks/${task.id}/commands`;
  const instruction = { action: 'append', expectedVersion: 1, text: 'Use three bullets' };
  assert.equal((await post(path, 'append', instruction)).status, 200);
  assert.equal((await post(path, 'append', instruction)).status, 200);
  assert.equal((await post(path, 'append', { ...instruction, text: 'Changed' })).status, 409);
  assert.equal((await post(path, 'cancel-stale', { action: 'cancel', expectedVersion: 1 })).status, 409);

  const futureCursor = await fetch(url + '/v1/stream?after=9999999', { headers });
  assert.equal(futureCursor.status, 409);

  const feed = await fetch(url + '/v1/stream?once=1', { headers: { ...headers, 'Last-Event-ID': String(snapshot.cursor) } });
  assert.equal(feed.status, 200);
  const chunk = await feed.text();
  assert.match(chunk, /task\.instruction_added/);
  assert.doesNotMatch(chunk, /task\.created/);

  const cancellation = await post(path, 'cancel', { action: 'cancel', expectedVersion: 2 });
  assert.equal((await cancellation.json()).status, 'cancelled');

  const registered = await post('/v1/app-connections', 'connect', { app: 'feishu', account: 'project account' });
  assert.equal(registered.status, 201);
  const scoped = await post('/v1/app-connections', 'connect-scoped', {
    app: 'feishu', account: 'project account', workspace: 'private',
  });
  assert.equal(scoped.status, 201);
  const { id: scopedConnection } = await scoped.json();
  const scopedImport = '/v1/app-connections/' + scopedConnection + '/capabilities/document.import';
  const scopedTest = '/v1/app-connections/' + scopedConnection + '/capabilities/document.test';
  assert.equal((await post(scopedTest, 'test-wrong-scope', { workspace: 'demo', document: 'doc123' })).status, 404);
  const unknown = await post('/v1/app-connections/' + scopedConnection + '/capabilities/document.publish',
    'unknown-capability', { workspace: 'private', document: 'doc123' });
  assert.equal(unknown.status, 404);
  const access = await post(scopedTest, 'test-right-scope', { workspace: 'private', document: 'doc123' });
  assert.equal(access.status, 200);
  assert.deepEqual(await access.json(), { readable: true });
  assert.deepEqual(memory.recall('test', 'private', 'findings', [scopedConnection]), []);
  assert.equal((await post(scopedImport, 'wrong-scope', { workspace: 'demo', document: 'doc123' })).status, 404);
  assert.equal((await post(scopedImport, 'right-scope', { workspace: 'private', document: 'doc123' })).status, 200);
  const usagePath = '/v1/app-connections/' + scopedConnection + '/usage';
  assert.equal((await fetch(url + usagePath)).status, 401);
  const usage = await (await fetch(url + usagePath, { headers })).json();
  assert.deepEqual(usage.usage.map(({ operation, status, workspace }) => ({ operation, status, workspace })), [
    { operation: 'import', status: 'succeeded', workspace: 'private' },
    { operation: 'test', status: 'succeeded', workspace: 'private' },
  ]);
  assert.doesNotMatch(JSON.stringify(usage), /doc123|Design review findings/);
  const scopedSearch = '/v1/app-connections/' + scopedConnection + '/capabilities/document.search';
  memory.remember('test', 'private', 'Unrelated findings note', { connection: scopedConnection, resource: 'manual', revision: '1' });
  const foundDocuments = await post(scopedSearch, 'search-right-scope', { workspace: 'private', query: 'findings' });
  assert.equal(foundDocuments.status, 200);
  const matches = (await foundDocuments.json()).items;
  assert.equal(matches.length, 1);
  assert.equal(matches[0].resource, 'doc123');
  assert.match(matches[0].excerpt, /Design review findings/);
  assert.equal((await post(scopedSearch, 'search-wrong-scope', { workspace: 'demo', query: 'findings' })).status, 404);
  const searchCommand = '/documents ' + scopedConnection + ' findings';
  const conversationSearch = await post('/v1/conversation', 'conversation-document-search', {
    workspace: 'private', text: searchCommand,
  });
  assert.equal(conversationSearch.status, 200);
  assert.match((await conversationSearch.json()).text, /doc123 · .*\n.*Design review findings/);
  assert.equal((await post('/v1/conversation', 'conversation-document-wrong-scope', {
    workspace: 'demo', text: searchCommand,
  })).status, 404);
  const previewCommand = '/document ' + scopedConnection + ' doc123';
  const conversationPreview = await post('/v1/conversation', 'conversation-live-document', {
    workspace: 'private', text: previewCommand,
  });
  assert.equal(conversationPreview.status, 200);
  assert.match((await conversationPreview.json()).text, /doc123 · sha256:.*\n\nDesign review findings/);
  assert.equal(store.recentConversation('test', 'private').length, 0);
  assert.equal((await post('/v1/conversation', 'conversation-live-document-wrong-scope', {
    workspace: 'demo', text: previewCommand,
  })).status, 404);
  memory.removeResource('test', scopedConnection, 'manual');
  const { id: connection } = await registered.json();
  const entry = await post('/v1/memory', 'memory', {
    workspace: 'demo', body: 'Approved review template',
    source: { connection, resource: 'review', revision: '2' },
  });
  assert.equal(entry.status, 201);
  const recall = '/v1/memory?workspace=demo&q=template';
  assert.deepEqual(await (await fetch(url + recall, { headers })).json(), { items: [] });
  const authorized = recall + '&source=' + connection;
  const found = await (await fetch(url + authorized, { headers })).json();
  assert.equal(found.items[0].revision, '2');
  const memoryPath = url + '/v1/memory/' + found.items[0].id;
  const revise = (expectedVersion: number, change: object) => fetch(memoryPath, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion, ...change }),
  });
  assert.deepEqual(await (await revise(1, { pinned: true })).json(), { version: 2 });
  assert.equal((await revise(1, { body: 'Stale correction' })).status, 409);
  assert.deepEqual(await (await revise(2, { body: 'Corrected review guideline' })).json(), { version: 3 });
  assert.deepEqual((await (await fetch(url + authorized, { headers })).json()).items, []);
  const corrected = await (await fetch(url + authorized.replace('q=template','q=guideline'), { headers })).json();
  assert.equal(corrected.items[0].pinned, 1);
  assert.equal(corrected.items[0].connection, connection);
  assert.equal(corrected.items[0].revision, '2');
  const editedHistory = await (await fetch(memoryPath + '/history', { headers })).json();
  assert.equal(editedHistory.item.version, 3);
  assert.deepEqual(editedHistory.edits.map(item => item.version), [2]);
  assert.doesNotMatch(JSON.stringify(editedHistory), /Corrected review guideline|"body"/);
  const importPath = '/v1/app-connections/' + connection + '/import-document';
  const imported = await post(importPath, 'import', { workspace: 'demo', document: 'doc123' });
  assert.equal(imported.status, 200);
  const document = await imported.json();
  assert.match(document.revision, /^sha256:[a-f0-9]{64}$/);
  const repeatImport = await post(importPath, 'import-repeat', { workspace: 'demo', document: 'doc123' });
  assert.equal((await repeatImport.json()).id, document.id);
  const draftSource = memory.recall('test', 'demo', 'findings', [connection])[0];
  const draftRequest = { workspace: 'demo', id: draftSource.id, version: draftSource.version };
  const draft = await post('/v1/memory/draft', 'draft', draftRequest);
  assert.equal(draft.status, 200);
  assert.deepEqual(await draft.json(), { body: 'Keep one review summary.' });
  assert.deepEqual(memory.recall('test', 'demo', 'one review summary', [connection]), []);
  assert.equal((await post('/v1/memory/draft', 'stale-draft', { ...draftRequest, version: 2 })).status, 409);
  const importedRecall = '/v1/memory?workspace=demo&q=findings&source=' + connection;
  assert.equal((await (await fetch(url + importedRecall, { headers })).json()).items[0].id, document.id);
  const githubRegistration = await post('/v1/app-connections', 'github', { app: 'github', account: 'engineering' });
  const { id: github } = await githubRegistration.json();
  const repoImport = '/v1/app-connections/' + github + '/import-document';
  const repoPreview = '/v1/app-connections/' + github + '/capabilities/document.read';
  const previewed = await (await post(repoPreview, 'github-preview', { workspace: 'demo', document: 'docs/review.md' })).json();
  assert.equal(previewed.text, githubBody);
  assert.equal(previewed.resource, 'docs/review.md');
  assert.equal(previewed.connection, github);
  assert.match(previewed.revision, /^sha256:/);
  assert.equal(previewed.truncated, false);
  assert.deepEqual(memory.recall('test', 'demo', 'findings', [github]), []);
  const liveAnswer = await post('/v1/memory/answer', 'selected-documents-answer', {
    workspace: 'demo', question: 'Compare selected documents', documents: [
      { connection, resource: 'doc123' },
      { connection: github, resource: 'docs/review.md', revision: previewed.revision },
    ],
  });
  assert.equal(liveAnswer.status, 200);
  const live = await liveAnswer.json();
  assert.equal(live.answer, 'Both documents contain review findings.');
  assert.deepEqual(live.sources.map(item => item.connection), [connection, github]);
  const stopAnswer = new AbortController();
  const timeout = AbortSignal.timeout(2_000);
  const abandoned = fetch(url + '/v1/memory/answer', {
    method: 'POST', signal: AbortSignal.any([stopAnswer.signal, timeout]),
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: 'demo', question: 'Cancel selected document answer',
      documents: [{ connection: github, resource: 'docs/review.md' }] }),
  });
  const aborted = assert.rejects(abandoned, { name: 'AbortError' });
  const deadline = new Promise<never>((_resolve, reject) =>
    timeout.addEventListener('abort', () => reject(timeout.reason), { once: true }));
  await Promise.race([answerStarted.promise, deadline]);
  stopAnswer.abort();
  await aborted;
  await Promise.race([answerCancelled.promise, deadline]);
  assert.deepEqual(memory.recall('test', 'demo', 'findings', [github]), []);
  const changedLive = await post('/v1/memory/answer', 'changed-selected-document', {
    workspace: 'demo', question: 'Compare selected documents',
    documents: [{ connection: github, resource: 'docs/review.md', revision: 'stale' }],
  });
  assert.equal(changedLive.status, 409);
  const repoHealth = '/v1/app-connections/' + github + '/capabilities/connection.health';
  assert.deepEqual(await (await post(repoHealth, 'github-health', { workspace: 'demo' })).json(), { status: 'succeeded' });
  assert.equal((await post(repoImport, 'bad-path', { workspace: 'demo', document: '../review.md' })).status, 400);
  assert.equal((await post(repoImport, 'github-import', { workspace: 'demo', document: 'docs/review.md' })).status, 200);
  const mixedRecall = importedRecall + '&source=' + github;
  const mixed = await (await fetch(url + mixedRecall, { headers })).json();
  assert.deepEqual(new Set(mixed.items.map(item => item.connection)), new Set([connection, github]));
  const multiSearch = await post('/v1/conversation', 'conversation-multiple-documents', {
    workspace: 'demo', text: '/documents ' + connection + ',' + github + ' findings',
  });
  assert.equal(multiSearch.status, 200);
  const multiSearchText = (await multiSearch.json()).text;
  assert.ok(multiSearchText.includes(connection + ' · doc123'));
  assert.ok(multiSearchText.includes(github + ' · docs/review.md'));
  assert.equal((await post('/v1/conversation', 'conversation-multiple-documents-wrong-scope', {
    workspace: 'demo', text: '/documents ' + github + ',' + scopedConnection + ' findings',
  })).status, 404);
  const missingReader = await (await post('/v1/app-connections', 'manual-account', {
    app: 'lark', account: 'not configured',
  })).json();
  const configured = await (await fetch(url + '/v1/app-connections', { headers })).json();
  const lastHealthCheck = configured.connections.find(item => item.id === github).lastHealthCheck;
  assert.equal(lastHealthCheck.status, 'succeeded');
  assert.equal(lastHealthCheck.workspace, 'demo');
  assert.equal(typeof lastHealthCheck.started, 'number');
  assert.equal(configured.connections.filter(item => item.canImportDocument).length, 3);
  assert.equal(configured.connections.find(item => item.id === scopedConnection)?.workspace, 'private');
  const successfulTest = configured.connections.find(item => item.id === scopedConnection).lastDocumentTest;
  assert.equal(successfulTest.status, 'succeeded');
  assert.equal(successfulTest.workspace, 'private');
  assert.equal(typeof successfulTest.started, 'number');
  const feishuDefinition = configured.definitions.find(item => item.id === 'feishu');
  assert.deepEqual(feishuDefinition.accounts, ['project account']);
  assert.deepEqual(feishuDefinition.capabilities.map(item => [item.id, item.effect]),
    [['document.test', 'read'], ['document.read', 'read'], ['document.import', 'local_write'], ['document.search', 'read'],
      ['document.refresh', 'local_write']]);
  assert.ok(configured.connections.find(item => item.id === scopedConnection).capabilities.every(item => item.state === 'configured'));
  const unconfigured = configured.connections.find(item => item.id === missingReader.id);
  assert.equal(unconfigured.capabilities.length, 5);
  assert.ok(unconfigured.capabilities.every(item => item.state === 'configuration_required'));
  assert.doesNotMatch(JSON.stringify(configured.definitions), /other-fixture|"token"|"secret"/);
  const scopedRecall = '/v1/memory?workspace=private&q=findings&source=' + scopedConnection;
  assert.equal((await (await fetch(url + scopedRecall, { headers })).json()).items.length, 1);
  const changedScope = await fetch(url + '/v1/app-connections/' + scopedConnection, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: 'archive' }),
  });
  assert.equal(changedScope.status, 200);
  assert.equal((await post('/v1/conversation', 'conversation-document-search', {
    workspace: 'private', text: searchCommand,
  })).status, 404);
  githubStatus = 403;
  assert.equal((await post('/v1/app-connections/' + github + '/test-document', 'github-test-denied',
    { workspace: 'demo', document: 'docs/other.md' })).status, 502);
  githubStatus = 200;
  const tested = await (await fetch(url + '/v1/app-connections', { headers })).json();
  assert.equal(tested.connections.find(item => item.id === scopedConnection).lastDocumentTest, undefined);
  assert.equal(tested.connections.find(item => item.id === github).lastDocumentTest.status, 'access_denied');
  assert.doesNotMatch(JSON.stringify(tested.connections.find(item => item.id === github).lastDocumentTest), /other\.md/);
  assert.deepEqual((await (await fetch(url + scopedRecall, { headers })).json()).items, []);
  assert.equal((await post(scopedImport, 'stale-scope', { workspace: 'private', document: 'doc123' })).status, 404);
  const answerRequest = { workspace: 'demo', query: 'findings', question: 'What did we find?' };
  const updateImported = (expectedVersion: number, disabled: boolean) => fetch(url + '/v1/memory/' + document.id, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion, disabled }),
  });
  assert.equal((await updateImported(1, true)).status, 200);
  assert.deepEqual((await (await fetch(url + importedRecall, { headers })).json()).items, []);
  assert.equal((await (await fetch(url + importedRecall + '&state=disabled', { headers })).json()).items[0].id, document.id);
  const disabledAnswer = await post('/v1/memory/answer', 'disabled-answer', { ...answerRequest, sources: [connection] });
  assert.deepEqual(await disabledAnswer.json(), { answer: null, sources: [] });
  assert.equal(memoryAnswers, 0);
  assert.equal((await updateImported(2, false)).status, 200);
  const emptyAnswer = await post('/v1/memory/answer', 'empty-answer', { ...answerRequest, sources: [] });
  assert.deepEqual(await emptyAnswer.json(), { answer: null, sources: [] });
  const unrelatedPersonal = memory.remember('test', 'demo', 'Personal findings excluded from this request')!;
  const answer = await post('/v1/memory/answer', 'answer', {
    ...answerRequest, sources: [connection], includePersonal: false,
  });
  const grounded = await answer.json();
  assert.match(grounded.answer, /design review findings/);
  assert.equal(grounded.sources[0].id, document.id);
  assert.equal(grounded.sources.length, 1);
  assert.equal(memory.remove('test', unrelatedPersonal), true);
  assert.equal(memoryAnswers, 1);
  assert.equal(store.recentConversation('test', 'demo').length, 0);
  const raceConnection = memory.connect('test', 'feishu', 'race account');
  memory.remember('test', 'demo', 'Design review findings', {
    connection: raceConnection, resource: 'doc123', revision: 'race',
  });
  revokeDuringAnswer = raceConnection;
  const movedAnswer = await post('/v1/memory/answer', 'move-answer', {
    ...answerRequest, question: 'Move now', sources: [raceConnection],
  });
  assert.equal(movedAnswer.status, 409);
  assert.doesNotMatch(await movedAnswer.text(), /design review findings/i);
  const revokedAnswer = await post('/v1/memory/answer', 'race-answer', {
    ...answerRequest, question: 'Revoke now', sources: [raceConnection],
  });
  assert.equal(revokedAnswer.status, 409);
  assert.doesNotMatch(await revokedAnswer.text(), /design review findings/i);
  const disconnected = await fetch(url + '/v1/app-connections/' + connection, { method: 'DELETE', headers });
  assert.equal(disconnected.status, 200);
  assert.equal((await fetch(memoryPath + '/history', { headers })).status, 404);
  const updatedConnections = await (await fetch(url + '/v1/app-connections', { headers })).json();
  const closedConnection = updatedConnections.connections.find(item => item.id === connection);
  assert.equal(closedConnection.canImportDocument, false);
  assert.ok(closedConnection.capabilities.every(item => item.state === 'disconnected'));
  assert.equal((await revise(3, { pinned: false })).status, 404);
  assert.equal((await post(importPath, 'revoked-import', { workspace: 'demo', document: 'doc123' })).status, 404);
  assert.deepEqual(await (await fetch(url + importedRecall, { headers })).json(), { items: [] });
  assert.deepEqual(await (await fetch(url + authorized, { headers })).json(), { items: [] });
  const remaining = await (await fetch(url + mixedRecall, { headers })).json();
  assert.deepEqual(remaining.items.map(item => item.connection), [github]);
  githubStatus = 503;
  assert.deepEqual(await (await post(repoHealth, 'github-health-unavailable', { workspace: 'demo' })).json(), { status: 'failed' });
  assert.equal((await post(repoImport, 'transient-github', { workspace: 'demo', document: 'docs/review.md' })).status, 502);
  assert.equal(memory.recall('test', 'demo', 'findings', [github]).length, 1);
  githubStatus = 404;
  assert.deepEqual(await (await post(repoHealth, 'github-health-denied', { workspace: 'demo' })).json(), { status: 'access_denied' });
  assert.equal(memory.connections('test').find(item => item.id === github)?.lastHealthCheck?.status, 'access_denied');
  assert.equal(memory.setConnectionWorkspace('test', github, 'other'), true);
  assert.equal(memory.setConnectionWorkspace('test', github, null), true);
  assert.equal(memory.connections('test').find(item => item.id === github)?.lastHealthCheck, undefined);
  assert.equal((await post(repoImport, 'missing-github', { workspace: 'demo', document: 'docs/review.md' })).status, 502);
  assert.deepEqual(memory.recall('test', 'demo', 'findings', [github]), []);
  githubStatus = 200;
  assert.equal((await post(repoImport, 'restored-github', { workspace: 'demo', document: 'docs/review.md' })).status, 200);
  assert.equal(memory.recall('test', 'demo', 'findings', [github]).length, 1);
  const refreshPath = '/v1/app-connections/' + github + '/capabilities/document.refresh';
  const otherWorkspace = await post(refreshPath, 'other-workspace-refresh', { workspace: 'other' });
  assert.deepEqual(await otherWorkspace.json(), { refreshed: 0, unavailable: 0, after: null });
  githubBody = 'Updated engineering guidance';
  const refreshed = await post(refreshPath, 'refresh-github', { workspace: 'demo' });
  assert.deepEqual(await refreshed.json(), { refreshed: 1, unavailable: 0, after: null });
  assert.deepEqual(memory.recall('test', 'demo', 'findings', [github]), []);
  assert.equal(memory.recall('test', 'demo', 'guidance', [github])[0]?.body, githubBody);
  const currentSource = memory.recall('test', 'demo', 'guidance', [github])[0];
  const sourceHistory = await (await fetch(url + '/v1/memory/' + currentSource.id + '/history', { headers })).json();
  assert.equal(sourceHistory.sourceRevisions.length, 2);
  assert.deepEqual(sourceHistory.sourceRevisions.map(item => item.current), [1, 0]);
  assert.equal(sourceHistory.sourceRevisions[0].id, currentSource.id);
  assert.doesNotMatch(JSON.stringify(sourceHistory), /Updated engineering guidance|Engineering review findings|"body"/);
  assert.equal(memory.history('other-owner', String(currentSource.id)), undefined);
  const syncPath = '/v1/app-connections/' + github + '/document-sync';
  assert.equal((await post(syncPath, 'enable-refresh', { workspace: 'demo', intervalMinutes: 15 })).status, 200);
  const scheduledReader = githubDocuments('engineering', 'example/handbook', 'fixture', async () =>
    new Response('Scheduled revision'));
  const syncSignal = AbortSignal.timeout(2_000);
  assert.equal(await runDueDocumentSync(memory, [scheduledReader], syncSignal), true);
  assert.equal(memory.recall('test', 'demo', 'Scheduled revision', [github]).length, 1);
  assert.equal(await runDueDocumentSync(memory, [scheduledReader], syncSignal), false);
  assert.equal((await post(syncPath, 'restart-schedule', { workspace: 'demo', intervalMinutes: 15 })).status, 200);
  const cancelledReader = githubDocuments('engineering', 'example/handbook', 'fixture', async () => {
    assert.equal(memory.setDocumentSync('test', github, 'demo', null), true);
    return new Response('Cancelled revision');
  });
  assert.equal(await runDueDocumentSync(memory, [cancelledReader], syncSignal), true);
  assert.equal(memory.recall('test', 'demo', 'Cancelled revision', [github]).length, 0);
  assert.equal(await runDueDocumentSync(memory, [scheduledReader], syncSignal), false);

  const registerDevice = async (name: string, workspace: string) => {
    const response = await post('/v1/admin/devices', name, { name, workspace });
    assert.equal(response.status, 201);
    return response.json();
  };
  const laptop = await registerDevice('Laptop', 'demo');
  const desktop = await registerDevice('Desktop', 'other');
  const devicePost = (token: string, path: string, data: object = {}) => fetch(url + '/v1/device/' + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  await post('/v1/events', 'device-task', { workspace: 'demo', text: 'Summarize the project notes' });
  const wrongWorkspace = await devicePost(desktop.token, 'claim', { capability: 'agent.acp', platform: 'darwin' });
  const listed = await (await fetch(url + '/v1/admin/devices', { headers })).json();
  const online = listed.devices.find(device => device.id === desktop.id);
  assert.equal(online.online, 1);
  assert.equal(online.capability, 'agent.acp');
  assert.equal(online.platform, 'darwin');
  assert.ok(online.lastSeen > 0);
  assert.equal('token' in online, false);
  assert.equal(listed.devices.find(device => device.id === laptop.id).online, 0);
  assert.deepEqual(await wrongWorkspace.json(), { assignment: null });
  assert.equal((await devicePost(token, 'claim')).status, 401);
  const claim = await devicePost(laptop.token, 'claim');
  const { assignment } = await claim.json();
  assert.equal(assignment.task.workspace, 'demo');
  const pathForRun = `runs/${assignment.run.id}`;
  assert.equal((await devicePost(desktop.token, pathForRun + '/finish', {
    status: 'succeeded', result: 'Other device',
  })).status, 409);
  assert.equal((await devicePost(laptop.token, pathForRun + '/renew')).status, 200);
  assert.equal((await fetch(url + '/v1/state', { headers: { Authorization: `Bearer ${laptop.token}` } })).status, 401);
  const revoke = await fetch(url + '/v1/admin/devices/' + laptop.id, { method: 'DELETE', headers });
  assert.equal(revoke.status, 200);
  assert.equal((await devicePost(laptop.token, pathForRun + '/renew')).status, 401);
  const afterRevoke = await (await fetch(url + '/v1/state', { headers })).json();
  assert.equal(afterRevoke.tasks.find(task => task.id === assignment.task.id).status, 'waiting_user');


  const directory = mkdtempSync(join(tmpdir(), 'blazar-preview-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'notes.md'), '# Project notes');
  const previewDevice = await registerDevice('Preview', 'preview');
  const ledger = new DeviceLedger(':memory:');
  t.after(() => ledger.close());
  const localRunner = new DeviceClient(new URL(url), previewDevice.token, await realpath(directory), ledger);
  const createPreview = await post('/v1/events', 'preview', { workspace: 'preview', text: '/preview notes.md' });
  const previewTask = await createPreview.json();
  assert.equal(await localRunner.runOnce(new AbortController().signal), true);
  assert.equal(await localRunner.runOnce(new AbortController().signal), false);
  assert.equal(store.get('test', previewTask.id)?.result, '# Project notes');
  assert.equal(store.get('test', previewTask.id)?.status, 'succeeded');
  const rememberResult = '/v1/tasks/' + previewTask.id + '/remember-result';
  assert.equal((await post(rememberResult, 'stale-result', { expectedVersion: 99 })).status, 409);
  const savedResult = await post(rememberResult, 'save-result', { expectedVersion: 1 });
  assert.equal(savedResult.status, 200);
  const { id: savedMemory } = await savedResult.json();
  const repeatedSave = await post(rememberResult, 'save-again', { expectedVersion: 1 });
  assert.equal((await repeatedSave.json()).id, savedMemory);
  const notes = memory.recall('test', 'preview', 'Project notes', []);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].taskId, previewTask.id);
  assert.equal(notes[0].taskVersion, 1);

  const previewSnapshot = await (await fetch(url + '/v1/state', { headers })).json();
  const artifact = previewSnapshot.artifacts.find(file => file.taskId === previewTask.id);
  assert.equal(artifact.name, 'preview.txt');
  assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(store.artifact('another-owner', artifact.id), undefined);
  assert.equal((await fetch(url + '/v1/artifacts/' + artifact.id)).status, 401);
  const download = await fetch(url + '/v1/artifacts/' + artifact.id, { headers });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('etag'), '"' + artifact.sha256 + '"');
  assert.equal(await download.text(), '# Project notes');

  // The Router committed the result, but the device restarted before seeing the response.
  await post('/v1/events', 'lost-response', { workspace: 'preview', text: '/preview notes.md' });
  const lostClaim = await devicePost(previewDevice.token, 'claim', { capability: 'document.preview' });
  const lost = (await lostClaim.json()).assignment;
  const outcome = {
    status: 'succeeded' as const, result: 'Replay me', artifact: { name: 'preview.txt', text: 'Replay me' },
  };
  const scope = createHash('sha256').update(JSON.stringify([url, previewDevice.token])).digest('hex');
  const ledgerPath = join(directory, 'ledger.sqlite');
  const initialLedger = new DeviceLedger(ledgerPath);
  initialLedger.save(scope, lost.run.id, outcome);
  assert.equal((await devicePost(previewDevice.token, `runs/${lost.run.id}/finish`, outcome)).status, 200);
  initialLedger.close();

  const restartedLedger = new DeviceLedger(ledgerPath);
  try {
    const restarted = new DeviceClient(new URL(url), previewDevice.token, await realpath(directory), restartedLedger);
    assert.equal(await restarted.runOnce(new AbortController().signal), true);
    assert.equal(restartedLedger.next(scope), undefined);
    assert.equal(store.snapshot('test').artifacts.filter(file => file.taskId === lost.task.id).length, 1);
    assert.equal((await devicePost(previewDevice.token, `runs/${lost.run.id}/finish`, {
      ...outcome, result: 'Different payload',
    })).status, 409);
  } finally {
    restartedLedger.close();
  }

  const codeResponse = await fetch(url + '/v1/pairings', { method: 'POST', headers });
  assert.equal(codeResponse.status, 201);
  const { code } = await codeResponse.json();
  const mobileToken = randomBytes(32).toString('base64url');
  const mobileHeaders = { Authorization: `Bearer ${mobileToken}` };
  const redeem = (token = mobileToken, name = 'iPhone') => fetch(url + '/v1/pairings/redeem', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name, token }),
  });
  const paired = await redeem();
  assert.equal(paired.status, 202);
  const mobile = await paired.json();
  assert.equal(mobile.token, undefined);
  const replay = await redeem();
  assert.equal(replay.status, 202);
  assert.deepEqual(await replay.json(), mobile);
  assert.equal((await redeem(randomBytes(32).toString('base64url'))).status, 404);
  assert.equal((await redeem(mobileToken, 'Different name')).status, 404);
  const pendingPath = '/v1/admin/mobile-pairings';
  const decision = pendingPath + '/' + mobile.id;
  const pairingStatus = () => fetch(url + '/v1/pairings/status?id=' + mobile.id, { headers: mobileHeaders });
  assert.equal((await fetch(url + '/v1/state', { headers: mobileHeaders })).status, 401);
  assert.deepEqual(await (await pairingStatus()).json(), { state: 'pending' });
  assert.equal((await fetch(url + '/v1/pairings/status?id=' + mobile.id, { headers })).status, 404);
  assert.equal((await fetch(url + decision, {
    method: 'POST', headers: { ...headers, 'X-Blazar-Public-Gateway': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve: true }),
  })).status, 401);
  const pendingRequests = await (await fetch(url + pendingPath, { headers })).json();
  assert.deepEqual(pendingRequests.requests, [{ id: mobile.id, name: 'iPhone', expires: mobile.expires }]);
  assert.equal((await post(decision, 'approve', { approve: true })).status, 200);
  assert.equal((await post(decision, 'approved-twice', { approve: true })).status, 404);
  assert.deepEqual(await (await pairingStatus()).json(), { state: 'approved' });
  assert.deepEqual(await (await redeem()).json(), mobile);
  assert.equal((await fetch(url + '/v1/state', { headers: mobileHeaders })).status, 200);
  const pushRegistration = (auth: object, deviceToken: string | null) => fetch(url + '/v1/mobile/push', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceToken }),
  });
  assert.equal((await pushRegistration(headers, 'aa')).status, 403);
  assert.equal((await pushRegistration(mobileHeaders, 'not-hex')).status, 400);
  assert.deepEqual(await (await pushRegistration(mobileHeaders, 'aa'.repeat(32))).json(), { enabled: true });
  assert.deepEqual(await (await pushRegistration(mobileHeaders, null)).json(), { enabled: false });

  const gatewayHeaders = { 'X-Blazar-Public-Gateway': '1' };
  assert.equal((await fetch(url + '/v1/state', { headers: { ...headers, ...gatewayHeaders } })).status, 401);
  assert.equal((await fetch(url + '/v1/state', { headers: { ...mobileHeaders, ...gatewayHeaders } })).status, 200);
  assert.equal((await fetch(url + '/v1/admin/devices', { headers: mobileHeaders })).status, 403);
  assert.equal((await fetch(url + '/v1/admin/metrics', { headers: mobileHeaders })).status, 403);
  assert.equal((await fetch(url + '/v1/admin/workers', { headers: mobileHeaders })).status, 403);
  const policyPath = url + '/v1/admin/worker-policies';
  const editPolicy = (protocols: unknown, auth: Record<string, string> = headers, maxConcurrent?: number, runLimitSeconds?: number, requireReadOnly?: unknown) => fetch(policyPath, {
    method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: 'policy-fixture', protocols, maxConcurrent, runLimitSeconds, requireReadOnly }),
  });
  assert.equal((await editPolicy(['codex'], mobileHeaders)).status, 403);
  assert.equal((await editPolicy(['invalid'])).status, 400);
  const setPolicy = await editPolicy(['jsonl', 'codex', 'codex']);
  assert.equal(setPolicy.status, 200);
  assert.deepEqual((await setPolicy.json()).policies, [{ workspace: 'policy-fixture', protocols: ['codex', 'jsonl'] }]);
  assert.deepEqual((await (await fetch(policyPath, { headers })).json()).policies,
    [{ workspace: 'policy-fixture', protocols: ['codex', 'jsonl'] }]);
  assert.equal((await editPolicy(['codex'], headers, 0)).status, 400);
  assert.equal((await editPolicy(['codex'], headers, 2, 29)).status, 400);
  assert.equal((await editPolicy(null, headers, undefined, 120)).status, 400);
  assert.equal((await editPolicy(['codex'], headers, 2, 120, 'yes')).status, 400);
  assert.deepEqual((await (await editPolicy(['codex'], headers, 2, 120, true)).json()).policies,
    [{ workspace: 'policy-fixture', protocols: ['codex'], maxConcurrent: 2, runLimitSeconds: 120, requireReadOnly: true }]);
  assert.deepEqual((await (await editPolicy(null)).json()).policies, []);
  assert.equal((await fetch(url + '/v1/admin/worker-registry', { headers: mobileHeaders })).status, 403);
  assert.equal((await fetch(url + '/v1/admin/worker-registry', { headers: { ...headers, 'X-Blazar-Public-Gateway': '1' } })).status, 401);
  const catalog = await (await fetch(url + '/v1/admin/workers', { headers })).json();
  assert.deepEqual(catalog.extensionProtocols, ['acp', 'jsonl']);
  assert.deepEqual(catalog.presets.map(item => item.id).sort(), [
    'aider', 'amp', 'antigravity', 'auggie', 'claude', 'cline', 'codex', 'copilot', 'cursor',
    'deepseek', 'droid', 'gemini', 'goose', 'kimi', 'kiro', 'opencode', 'pi', 'qwen',
  ]);
  assert.deepEqual(catalog.presets.find(item => item.id === 'deepseek'), {
    id: 'deepseek', label: 'DeepSeek Harness', protocol: 'acp',
  });
  const streamPath = url + '/v1/stream?once=1&after=' + store.eventCursor();
  const openFeed = await fetch(streamPath, { headers: mobileHeaders });
  assert.equal(openFeed.status, 200);
  assert.equal((await fetch(url + '/v1/admin/mobile-clients/' + mobile.id, { method: 'DELETE', headers })).status, 200);
  assert.equal((await fetch(url + '/v1/state', { headers: mobileHeaders })).status, 401);
  store.create('test', 'fixture', 'post-mobile-revocation', 'demo', 'Created after removing the phone');
  assert.equal(await openFeed.text(), '');
  assert.equal((await fetch(streamPath, { headers: mobileHeaders })).status, 401);
  assert.deepEqual(await (await pairingStatus()).json(), { state: 'denied' });
  const rejectedCode = await (await fetch(url + '/v1/pairings', { method: 'POST', headers })).json();
  const rejectedToken = randomBytes(32).toString('base64url');
  const rejected = await (await post('/v1/pairings/redeem', 'denial-fixture', {
    code: rejectedCode.code, name: 'Unknown phone', token: rejectedToken,
  })).json();
  assert.equal((await post(pendingPath + '/' + rejected.id, 'deny', { approve: false })).status, 200);
  const rejectedHeaders = { Authorization: 'Bearer ' + rejectedToken };
  assert.deepEqual(await (await fetch(url + '/v1/pairings/status?id=' + rejected.id, { headers: rejectedHeaders })).json(),
    { state: 'denied' });
  assert.equal((await fetch(url + '/v1/state', { headers: rejectedHeaders })).status, 401);

  const question = { workspace: 'demo', text: 'Could you help?' };
  const asked = await post('/v1/conversation', 'ask', question);
  assert.deepEqual(await asked.json(), { kind: 'clarify', text: 'Which project?' });
  assert.equal((await post('/v1/conversation', 'ask', question)).status, 200);
  assert.equal((await post('/v1/conversation', 'ask', { ...question, text: 'Another prompt' })).status, 409);
  assert.equal(decisions, 1);
  const followUp = await post('/v1/conversation', 'follow-up', { workspace: 'demo', text: 'The design project' });
  assert.equal(followUp.status, 202);
  assert.equal((await followUp.json()).task.goal, 'Help with the design project');
  assert.equal(store.recentConversation('another-owner', 'demo').length, 0);
  assert.equal(store.recentConversation('test', 'another-workspace').length, 0);
  const routed = await post('/v1/conversation', 'route', { workspace: 'demo', text: 'Draft a reply' });
  assert.equal(routed.status, 202);
  assert.equal((await routed.json()).task.goal, 'Draft a reply');
  assert.equal(decisions, 3);
  assert.equal((await post('/v1/conversation', 'fast-path', { workspace: 'demo', text: '/preview notes.md' })).status, 202);
  assert.equal(decisions, 3);

  const beforePlan = store.snapshot('test').tasks.length;
  const proposed = await post('/v1/conversation', 'plan', { workspace: 'demo', text: 'Plan the review' });
  assert.equal(proposed.status, 200);
  const plan = await proposed.json();
  assert.equal(plan.kind, 'propose_workflow');
  assert.equal(store.snapshot('test').tasks.length, beforePlan);
  const confirmed = await post('/v1/workflows', 'confirm-plan', { workspace: 'demo', steps: plan.steps });
  assert.equal(confirmed.status, 202);
  assert.equal(store.snapshot('test').tasks.length, beforePlan + 2);
  assert.equal((await post('/v1/workflows', 'invalid-plan', {
    workspace: 'demo', steps: [{ key: 'loop', goal: 'Draft notes', needs: ['loop'] }],
  })).status, 400);

  assert.equal((await post('/v1/workflows', 'invalid-criteria', {
    workspace: 'demo', steps: [{ key: 'draft', goal: 'Draft notes', needs: [], acceptanceCriteria: [42] }],
  })).status, 400);
  const metrics = await fetch(url + '/v1/admin/metrics', { headers });
  assert.equal(metrics.status, 200);
  const measurement = await metrics.json();
  assert.deepEqual(measurement.routing, { deterministic: 4, model: 4, replayed: 1, modelErrors: 0 });
  assert.equal(measurement.latencyMs.model.count, 4);
  assert.deepEqual(measurement.modelTokens, {
    samples: 4, input: 40, output: 16, cacheRead: 8, cacheWrite: 0, totalTokens: 64,
  });
  assert.ok(measurement.latencyMs.event.count > 0);
  assert.ok(measurement.devices.active > 0);
  assert.equal(Object.values(measurement.tasks).reduce((sum, count) => Number(sum) + Number(count), 0),
    store.snapshot('test').tasks.length);

  const personal = memory.remember('test', 'memory-review', 'Review format: three bullets.')!;
  memory.remember('test', 'other-workspace', 'Review format: private elsewhere.');
  memory.remember('test', 'memory-review', 'Review format: imported text.', {
    connection: github, resource: 'docs/format.md', revision: '1',
  });
  const memoryQuestion = { workspace: 'memory-review', text: 'Review format?' };
  assert.equal((await post('/v1/conversation', 'plain-review', memoryQuestion)).status, 200);
  assert.equal(routingMemory, undefined);
  assert.equal((await post('/v1/conversation', 'memory-review', { ...memoryQuestion, usePersonalMemory: true })).status, 200);
  assert.deepEqual(routingMemory, ['Review format: three bullets.']);
  assert.equal(store.recentConversation('test', 'memory-review').length, 1);
  routingMemoryId = personal;
  assert.equal((await post('/v1/conversation', 'memory-race', { ...memoryQuestion, usePersonalMemory: true })).status, 409);

  const existing = store.create('test', 'fixture', 'append-existing', 'follow-up', 'Draft the review');
  const append = { workspace: 'follow-up', text: 'Add tests to the review' };
  const proposal = await (await post('/v1/conversation', 'append-proposal', append)).json();
  assert.deepEqual(proposal, {
    kind: 'append_task', taskId: existing.id, text: 'Add test coverage.',
    instruction: 'Include tests.', expectedVersion: 1,
  });
  assert.equal(store.get('test', existing.id)?.version, 1);
  const command = { action: 'append', text: proposal.instruction, expectedVersion: proposal.expectedVersion };
  assert.equal((await post('/v1/tasks/' + existing.id + '/commands', 'confirm-follow-up', command)).status, 200);
  assert.deepEqual(await (await post('/v1/conversation', 'append-proposal', append)).json(), proposal);
  assert.equal((await post('/v1/tasks/' + existing.id + '/commands', 'stale-follow-up', command)).status, 409);
  assert.equal(store.get('test', existing.id)?.version, 2);
  store.create('test', 'fixture', 'hidden-status', 'private', 'Draft the review privately');
  const priorDecisions = decisions;
  const status = await post('/v1/conversation', 'lookup-status', { workspace: 'follow-up', text: '/status Draft the review' });
  assert.deepEqual(await status.json(), { kind: 'reply', text: 'queued · Draft the review' });
  const localStatus = await post('/v1/conversation', 'lookup-status-zh', { workspace: 'follow-up', text: '/状态' });
  assert.deepEqual(await localStatus.json(), { kind: 'reply', text: '排队中 · Draft the review' });
  assert.equal(decisions, priorDecisions);

});

test('admin progress retention expires replay cursors and preserves durable task events', async t => {
  const store = new TaskStore(':memory:');
  const server = routerServer(store, { owner: 'test', token: 'local' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  const admin = { Authorization: 'Bearer local' };
  const phone = store.redeemPairing(store.createPairing('test', Date.now()).code, 'Phone', Date.now())!;
  const task = store.create('test', 'fixture', 'retention', 'project', 'Summarize notes');
  const now = Date.now();
  const { run } = store.claim('test', 'project', 'device', now, 10_000)!;
  const beforeProgress = store.eventCursor();
  assert.equal(store.progress(run.id, 'device', now, 1, 'Reading'), true);
  const progressCursor = store.eventCursor();
  const reportedAt = Date.now();
  while (Date.now() <= reportedAt) await new Promise(resolve => setTimeout(resolve, 2));
  const prune = (auth: string, before: number) => fetch(base + '/v1/admin/event-retention', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ before }),
  });
  const cutoff = Date.now();
  assert.equal((await prune(phone.token, cutoff)).status, 403);
  assert.equal((await prune('local', cutoff + 60_000)).status, 400);
  assert.deepEqual(await (await prune('local', cutoff)).json(), { removed: 1 });
  assert.deepEqual(await (await prune('local', cutoff)).json(), { removed: 0 });
  assert.equal(store.eventCursor(), progressCursor);
  assert.equal((await fetch(base + '/v1/stream?after=' + beforeProgress, { headers: admin })).status, 409);
  const state = await (await fetch(base + '/v1/state', { headers: admin })).json();
  assert.equal(state.cursor, progressCursor);
  assert.equal(state.progress[0].message, 'Reading');

  assert.equal(store.finish(run.id, 'device', Date.now(), { status: 'succeeded', result: 'Done' }), true);
  const feed = await fetch(base + '/v1/stream?once=1&after=' + state.cursor, { headers: admin });
  assert.match(await feed.text(), /run\.finished/);
  const live = await fetch(base + '/v1/stream?once=1&after=' + store.eventCursor(), { headers: admin });
  store.create('test', 'fixture', 'live-event', 'project', 'Read the status');
  assert.match(await live.text(), /task\.created/);
  const metrics = await (await fetch(base + '/v1/admin/metrics', { headers: admin })).json();
  assert.deepEqual(metrics.stream, { opened: 2, replayedEvents: 1, resnapshotRequired: 1 });
  const timeline = store.timeline('test', task.id)!;
  assert.deepEqual(timeline.events.map(event => event.type), ['run.finished', 'run.started', 'task.created']);
});

test('admin audit export pages within an owner-scoped cursor range', async t => {
  const store = new TaskStore(':memory:');
  const server = routerServer(store, { owner: 'test', token: 'local' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = 'http://127.0.0.1:' + address.port + '/v1/admin/audit-export';
  const unrelated = store.create('another', 'fixture', 'private', 'project', 'Unrelated task');
  const taskIds = Array.from({ length: 101 }, (_, index) =>
    store.create('test', 'fixture', 'audit-' + index, 'project', 'Local task').id);
  const fetchAudit = (query = '', token = 'local') =>
    fetch(endpoint + query, { headers: { Authorization: 'Bearer ' + token } });
  const phone = store.redeemPairing(store.createPairing('test', Date.now()).code, 'Phone', Date.now())!;
  assert.equal((await fetchAudit('', phone.token)).status, 403);
  assert.equal((await fetchAudit('?after=2&through=1')).status, 400);
  const first = await (await fetchAudit()).json();
  assert.equal(first.events.length, 100);
  assert.equal(first.events[0].taskId, taskIds[0]);
  store.create('test', 'fixture', 'later', 'project', 'Later task');
  const second = await (await fetchAudit('?after=' + first.nextAfter + '&through=' + first.through)).json();
  assert.equal(second.nextAfter, null);
  assert.deepEqual(second.events.map((event: { taskId: string }) => event.taskId), [taskIds[100]]);
  assert.ok(!JSON.stringify(first).includes(unrelated.id));
});

test('Router capability tools only expose active connections and devices in the administrator workspace', async t => {
  const store = new TaskStore(':memory:');
  const memory = new MemoryStore(':memory:');
  const desktop = store.registerDevice('owner', 'Workspace desktop', 'project');
  store.recordDeviceActivity(desktop.id, Date.now(), 'computer.observe');
  store.recordDesktopApps(desktop.id, ['notes'], undefined, [{ alias: 'notes', buttons: ['Add'], visual: false }]);
  store.registerDevice('owner', 'Separate workspace', 'other');
  store.registerDevice('other', 'Separate owner', 'project');
  memory.connect('owner', 'feishu', 'authorized account', 'project');
  memory.connect('owner', 'github', 'unconfigured account');
  memory.connect('owner', 'lark', 'other workspace account', 'other');
  memory.connect('other', 'lark', 'other owner account', 'project');
  memory.disconnect('owner', memory.connect('owner', 'lark', 'revoked account', 'project'));
  const phone = store.redeemPairing(store.createPairing('owner', Date.now()).code, 'Phone', Date.now())!;
  const task = store.create('owner', 'fixture', 'scope-task', 'project', 'Private event payload');
  const otherTask = store.create('owner', 'fixture', 'other-space', 'other', 'Other workspace');
  const foreignTask = store.create('other', 'fixture', 'other-owner', 'project', 'Other owner');
  const summaries: unknown[] = [];
  const historyLengths: number[] = [];
  const server = routerServer(store, {
    owner: 'owner', token: 'admin-secret', memory,
    documents: [feishuDocuments('feishu', 'authorized account', 'fixture')],
    async harness(input) {
      assert.deepEqual(input.taskEvents?.(task.id), [{ seq: 1, type: 'task.created' }]);
      assert.deepEqual(input.taskEvents?.('Private event'), [{ seq: 1, type: 'task.created' }]);
      assert.equal(input.taskEvents?.(otherTask.id), undefined);
      assert.equal(input.taskEvents?.(foreignTask.id), undefined);
      summaries.push(input.workspaceCapabilities?.());
      historyLengths.push(input.recent.length);
      return { kind: 'reply', text: input.workspaceCapabilities ? 'Administrator summary' : 'Mobile summary' };
    },
  });
  server.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    memory.close();
    store.close();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const ask = (token: string, key: string) => fetch('http://127.0.0.1:' + address.port + '/v1/conversation', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ workspace: 'project', text: 'What is connected?' }),
  });
  assert.equal((await (await ask('admin-secret', 'same-key')).json()).text, 'Administrator summary');
  assert.equal((await (await ask(phone.token, 'same-key')).json()).text, 'Mobile summary');
  assert.equal((await (await ask(phone.token, 'follow-up')).json()).text, 'Mobile summary');
  assert.deepEqual(historyLengths, [0, 0, 1]);
  assert.deepEqual(summaries, [{
    desktopTargets: [{ alias: 'notes', deviceId: desktop.id }],
    devices: [{ name: 'Workspace desktop', capability: 'computer.observe', online: true, available: true }],
    apps: [{ app: 'github', documentRead: false }, { app: 'feishu', documentRead: true }],
  }, undefined, undefined]);

  const submit = (alias: string) => fetch('http://127.0.0.1:' + address.port + '/v1/workflows', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + phone.token, 'Content-Type': 'application/json', 'Idempotency-Key': 'observe-flow' },
    body: JSON.stringify({ workspace: 'project', steps: [
      { key: 'observe', goal: 'Inspect Notes', needs: [],
        action: { kind: 'desktop.observe', alias, deviceId: desktop.id } },
      { key: 'summarize', goal: 'Summarize the observation', needs: ['observe'] },
    ] }),
  });
  assert.equal((await submit('unknown')).status, 404);
  const workflow = await submit('notes');
  assert.equal(workflow.status, 202);
  const result = await workflow.json();
  const now = Date.now();
  assert.equal(store.claim('owner', 'project', 'different-device', now, 45_000, '/observe '), undefined);
  const observation = store.claim('owner', 'project', desktop.id, now, 45_000, '/observe ', '', undefined, undefined, ['notes'])!;
  assert.equal(observation.task.id, result.steps[0].taskId);
  assert.equal(observation.task.goal, '/observe notes');
  assert.equal(store.finish(observation.run.id, desktop.id, now, {
    status: 'succeeded', result: 'Notes contain a draft', artifact: { name: 'observation.txt', text: 'Notes contain a draft' },
  }), true);
  const claimWorker = () => store.claim('owner', 'project', 'worker', now, 45_000, '', '/preview ', undefined, undefined, undefined, true)!;
  const earlier = claimWorker();
  assert.equal(earlier.task.id, task.id);
  assert.ok(store.finish(earlier.run.id, 'worker', now, { status: 'succeeded', result: 'Fixture completed' }));
  const downstream = claimWorker();
  assert.equal(downstream.task.id, result.steps[1].taskId);
  assert.equal(downstream.predecessors[0].artifact?.excerpt, 'Notes contain a draft');

  const click = (button: string) => fetch('http://127.0.0.1:' + address.port + '/v1/workflows', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + phone.token, 'Content-Type': 'application/json', 'Idempotency-Key': 'click-flow' },
    body: JSON.stringify({ workspace: 'project', steps: [{
      key: 'click', goal: 'Add an item in Notes', needs: [], action: {
        kind: 'desktop.click', alias: 'notes', deviceId: desktop.id, windowId: 'w-10',
        windowIdentity: 'a'.repeat(64), button, expectedText: 'Saved',
      },
    }] }),
  });
  assert.equal((await click('Delete')).status, 404);
  const admitted = await click('Add');
  assert.equal(admitted.status, 202);
  const clicked = await admitted.json();
  const action = store.claim('owner', 'project', desktop.id, now, 45_000, '/observe ', '', undefined, undefined, ['notes'])!;
  assert.equal(action.task.id, clicked.steps[0].taskId);
  assert.equal(action.clickExpectedText, 'Saved');
  assert.equal(action.task.goal, '/click notes --window w-10 --instance ' + 'a'.repeat(64) + ' Add');
});

test('task and workflow intake deduplicate per paired phone and administrator', async t => {
  const store = new TaskStore(':memory:');
  const server = routerServer(store, { owner: 'owner', token: 'admin-secret' });
  const pair = (name: string) => store.redeemPairing(store.createPairing('owner', Date.now()).code, name, Date.now())!;
  const first = pair('First phone');
  const second = pair('Second phone');
  server.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const submit = (token: string, text: string) => fetch('http://127.0.0.1:' + address.port + '/v1/events', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': 'shared-key' },
    body: JSON.stringify({ workspace: 'project', text }),
  });
  const response = await Promise.all([
    submit(first.token, 'Review the first report'),
    submit(second.token, 'Review the second report'),
    submit('admin-secret', 'Review the second report'),
  ]);
  assert.deepEqual(response.map(item => item.status), [202, 202, 202]);
  const tasks = await Promise.all(response.map(item => item.json()));
  assert.equal(new Set(tasks.map(task => task.id)).size, 3);
  const replay = await submit(second.token, 'Review the second report');
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).id, tasks[1].id);
  assert.equal((await submit(second.token, 'Different request')).status, 409);
  assert.equal(store.snapshot('owner').tasks.length, 3);

  const createWorkflow = (token: string, goal: string) => fetch('http://127.0.0.1:' + address.port + '/v1/workflows', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': 'shared-key' },
    body: JSON.stringify({ workspace: 'project', steps: [{ key: 'draft', goal, needs: [] }] }),
  });
  const workflowResponses = await Promise.all([
    createWorkflow(first.token, 'Draft first report'),
    createWorkflow(second.token, 'Draft second report'),
    createWorkflow('admin-secret', 'Draft second report'),
  ]);
  assert.deepEqual(workflowResponses.map(item => item.status), [202, 202, 202]);
  const workflows = await Promise.all(workflowResponses.map(item => item.json()));
  assert.equal(new Set(workflows.map(workflow => workflow.id)).size, 3);
  const workflowReplay = await createWorkflow(second.token, 'Draft second report');
  assert.equal(workflowReplay.status, 202);
  assert.deepEqual(await workflowReplay.json(), workflows[1]);
  assert.equal((await createWorkflow(second.token, 'Different plan')).status, 409);
  assert.equal(store.snapshot('owner').tasks.length, 6);
});

test('concurrent conversation retries share routing and reject in-flight key conflicts', { timeout: 5000 }, async t => {
  const store = new TaskStore(':memory:');
  const entered = Promise.withResolvers<void>();
  const saturated = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const server = routerServer(store, {
    owner: 'owner', token: 'admin',
    async harness() {
      calls++;
      entered.resolve();
      if (calls === 4) saturated.resolve();
      await release.promise;
      return { kind: 'create_task' };
    },
  });
  server.listen(0, '127.0.0.1');
  t.after(async () => {
    release.resolve();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const ask = (text: string, key = 'same-key') => fetch('http://127.0.0.1:' + address.port + '/v1/conversation', {
    method: 'POST', signal: AbortSignal.timeout(3_000),
    headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ workspace: 'project', text }),
  });
  const first = ask('Review the report');
  await entered.promise;
  const replay = ask('Review the report');
  const otherRoutes = ['one', 'two', 'three'].map(key => ask('Review ' + key, key));
  try {
    await saturated.promise;
    assert.equal((await ask('Review a different report')).status, 409);
    assert.equal((await ask('Try another report', 'over-limit')).status, 429);
    assert.equal((await ask('/status', 'status')).status, 200);
    const task = store.create('owner', 'fixture', 'cancel', 'project', 'Cancel under load');
    const cancellation = await fetch('http://127.0.0.1:' + address.port + '/v1/tasks/' + task.id + '/commands', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json', 'Idempotency-Key': 'cancel-test' },
      body: JSON.stringify({ action: 'cancel', expectedVersion: task.version }),
    });
    assert.equal(cancellation.status, 200);
    assert.equal((await cancellation.json()).status, 'cancelled');
    assert.equal(calls, 4);
  } finally {
    release.resolve();
  }
  const responses = await Promise.all([first, replay]);
  assert.deepEqual(responses.map(response => response.status), [202, 202]);
  const [original, repeated] = await Promise.all(responses.map(response => response.json()));
  assert.equal(original.task.id, repeated.task.id);
  assert.deepEqual((await Promise.all(otherRoutes)).map(response => response.status), [202, 202, 202]);
  assert.equal((await ask('Try another report', 'over-limit')).status, 202);
  assert.equal(calls, 5);
  assert.equal(store.snapshot('owner').tasks.length, 6);
});

test('Router decisions can consume versioned text results without crossing workspace boundaries', async t => {
  const store = new TaskStore(':memory:');
  const resultTask = store.create('owner', 'fixture', 'result', 'project', 'Inspect Notes');
  const other = store.create('owner', 'fixture', 'external', 'outside', 'Private observation');
  const now = Date.now();
  const { run } = store.claim('owner', 'project', 'device', now, 45_000)!;
  assert.ok(store.finish(run.id, run.device, now, {
    status: 'succeeded', result: 'Notes inspected', artifact: { name: 'notes.txt', text: 'A draft is visible' },
  }));
  const server = routerServer(store, {
    owner: 'owner', token: 'admin',
    async harness(input) {
      assert.equal(input.taskResult?.(other.id), undefined);
      assert.deepEqual(input.taskResult?.('Inspect Notes'), {
        taskId: resultTask.id, version: 1, result: 'Notes inspected',
        artifact: { name: 'notes.txt', excerpt: 'A draft is visible', size: 18 },
      });
      if (input.text === 'Change during routing') {
        assert.ok(store.command('owner', resultTask.id, 1, { action: 'append', text: 'Inspect again' }));
      }
      if (input.text.startsWith('Plan')) return {
        kind: 'propose_workflow', text: 'Review the draft.',
        steps: [{ key: 'review', goal: 'Review the draft', needs: [] }],
      };
      return { kind: 'reply', text: 'A draft is visible.' };
    },
  });
  server.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const ask = (text: string) => fetch('http://127.0.0.1:' + address.port + '/v1/conversation', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json', 'Idempotency-Key': text },
    body: JSON.stringify({ workspace: 'project', text }),
  });
  assert.deepEqual(await (await ask('What was visible?')).json(), { kind: 'reply', text: 'A draft is visible.' });
  const { proposalKey, steps } = await (await ask('Plan the review')).json();
  assert.equal(proposalKey, 'Plan the review');
  const confirm = (key: string, proposal: string, selected = steps) =>
    fetch('http://127.0.0.1:' + address.port + '/v1/workflows', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ workspace: 'project', steps: selected, proposalKey: proposal }),
    });
  assert.equal((await confirm('altered', proposalKey, [{ key: 'different', goal: 'Different plan', needs: [] }])).status, 409);
  const admitted = await confirm('original', proposalKey);
  assert.equal(admitted.status, 202);
  const { id, steps: admittedSteps } = await admitted.json();
  assert.equal((await (await confirm('retry', proposalKey)).json()).id, id);
  const active = store.claim('owner', 'project', 'plan-device', now + 1, 45_000)!.run;
  assert.equal(active.taskId, admittedSteps[0].taskId);
  const queued = await (await ask('Plan a queued review')).json();
  const queuedResponse = await confirm('queued', queued.proposalKey, queued.steps);
  assert.equal(queuedResponse.status, 202);
  const queuedWorkflow = await queuedResponse.json();
  const stale = await (await ask('Plan a second review')).json();
  assert.equal((await ask('Change during routing')).status, 409);
  assert.equal((await ask('What was visible?')).status, 409);
  assert.equal((await confirm('outdated', stale.proposalKey, stale.steps)).status, 409);
  assert.equal(store.get('owner', queuedWorkflow.steps[0].taskId)?.status, 'waiting_user');
  assert.equal(store.command('owner', queuedWorkflow.steps[0].taskId, 1, { action: 'retry' }), undefined);
  assert.equal(store.renew(active.id, active.device, now + 2, 45_000), undefined);
  assert.deepEqual(store.deviceStopTargets(active.device).map(target => target.id), [active.id]);
  assert.equal(store.acknowledgeStop(active.id, active.device, now + 2), true);
  assert.equal(store.get('owner', active.taskId)?.status, 'waiting_user');
  assert.equal(store.finish(active.id, active.device, now + 2, { status: 'succeeded', result: 'Stale result' }), false);
  assert.deepEqual(store.recentConversation('owner', 'project'), []);
});
