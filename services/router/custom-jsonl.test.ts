import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runCustomJsonl } from '../../packages/workers/custom-jsonl.ts';
import { resolveWorker } from '../../packages/workers/registry.ts';
import { DeviceClient } from '../device/client.ts';
import { DeviceLedger } from '../device/ledger.ts';
import { routerServer } from './http.ts';
import { MemoryStore } from './memory.ts';
import { TaskStore } from './store.ts';

test('a registered JSONL extension executes a real subprocess through Router and DeviceClient', async t => {
  const root = await mkdtemp(join(tmpdir(), 'blazar-extension-'));
  const script = join(root, 'worker.cjs');
  await writeFile(script, `
    const request = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
    if (request.version !== 1 || request.type !== 'run') process.exit(2);
    if (request.input.goal === 'Recover a failed attempt') {
      const history = request.input.previousRuns;
      if (!history) {
        console.log(JSON.stringify({version:1,type:'failed',message:'Private prior diagnostic'}));
        return;
      }
      if (history.length !== 1 || history[0].outcome !== 'failed' ||
          !/^[a-f0-9-]{36}$/.test(history[0].runId) || !Number.isSafeInteger(history[0].eventSeq) ||
          JSON.stringify(request.input).includes('Private prior diagnostic')) process.exit(9);
      console.log(JSON.stringify({version:1,type:'completed',result:'Previous attempt identified'}));
      return;
    }
    if (request.input.goal === 'Wait with the forecast') {
      if (!request.input.backgroundMemory?.some(note => note.body === 'Forecast input active')) process.exit(8);
      console.log(JSON.stringify({version:1,type:'progress',message:'Forecast input loaded'}));
      setInterval(() => {}, 1000);
      return;
    }
    if (request.input.goal === 'Inspect the attachment') {
      const [attachment] = request.input.attachments ?? [];
      if (attachment?.name !== 'notes.txt' || attachment.text !== 'Attachment fixture body' ||
          request.input.instructions.length) process.exit(7);
      console.log(JSON.stringify({version:1,type:'completed',result:'Attachment verified'}));
      return;
    }
    if (request.input.goal === 'Verify upstream file') {
      const artifact = request.input.predecessorResults[0].artifact;
      if (artifact.text !== 'Z'.repeat(2500) || artifact.excerpt.length !== 2000 ||
          request.input.acceptanceCriteria?.[0] !== 'Check the full input') process.exit(3);
      console.log(JSON.stringify({version:1,type:'completed',result:'Complete input verified'}));
      return;
    }
    if (request.input.goal === 'Wait for follow-up' && request.input.instructions.length) {
      console.log(JSON.stringify({version:1,type:'completed',result:request.input.instructions.join(' ')}));
      return;
    }
    if (['Use the review template', 'Wait with the review template', 'Review the preceding draft'].includes(request.input.goal)) {
      if (request.input.goal === 'Review the preceding draft' &&
          request.input.predecessorResults?.[0]?.result !== 'Private review template') process.exit(6);
      const evidence = request.input.backgroundMemory;
      if (evidence?.length !== 1 || evidence[0].body !== 'Private review template') process.exit(5);
      if (request.input.goal === 'Wait with the review template') {
        console.log(JSON.stringify({version:1,type:'progress',message:'Review template loaded'}));
        setInterval(() => {}, 1000);
        return;
      }
      console.log(JSON.stringify({version:1,type:'completed',result:evidence[0].body}));
      return;
    }
    if (request.input.goal === 'Wait for pause' || request.input.goal === 'Wait for follow-up') {
      console.log(JSON.stringify({version:1,type:'progress',message:'Ready to pause'}));
      setInterval(() => {}, 1000);
      return;
    }
    if (request.input.goal !== 'Summarize notes') process.exit(2);
    if (request.input.backgroundMemory?.length !== 1 ||
        request.input.backgroundMemory[0].body !== 'Prefer notes in bullet points') process.exit(4);
    console.log(JSON.stringify({version:1,type:'progress',message:'Read the input'}));
    console.log(JSON.stringify({version:1,type:'completed',result:'Fixture summary'}));
  `);
  const manifest = join(root, 'worker.json');
  await writeFile(manifest, JSON.stringify({
    version: 1, protocol: 'jsonl', label: 'Fixture JSONL', executable: process.execPath, args: [script],
    includeFullInputArtifacts: true,
  }));
  const worker = await resolveWorker('custom', manifest);
  assert.equal(worker?.protocol, 'jsonl');
  const memory = new MemoryStore(':memory:');
  const store = new TaskStore(':memory:',
    (owner, workspace, refs) => Boolean(memory.resolveAppEvidence(owner, workspace, refs)));
  const ledger = new DeviceLedger(':memory:');
  let routedTaskCount: number | undefined;
  const server = routerServer(store, { owner: 'owner', token: 'local', memory,
    async harness(input) {
      routedTaskCount = input.findTasks?.('Use the review template').length;
      return { kind: 'reply', text: 'No model-visible task matched.' };
    },
  });
  const device = store.registerDevice('owner', 'Extension fixture', 'project');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new DeviceClient(new URL('http://127.0.0.1:' + address.port), device.token, root, ledger, worker);
  t.after(async () => {
    client.close();
    server.closeDeviceSockets();
    await new Promise<void>(resolve => server.close(() => resolve()));
    ledger.close();
    memory.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const legacyDevice = store.registerDevice('owner', 'Legacy fixture', 'project');
  const expectNoLegacyAssignment = async () => {
    const claim = await fetch('http://127.0.0.1:' + address.port + '/v1/device/claim', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + legacyDevice.token, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(claim.status, 200);
    assert.deepEqual(await claim.json(), { assignment: null });
  };

  const note = memory.remember('owner', 'project', 'Prefer notes in bullet points');
  memory.remember('owner', 'private', 'These notes are outside the workspace');
  const created = await fetch('http://127.0.0.1:' + address.port + '/v1/events', {
    method: 'POST', headers: {
      Authorization: 'Bearer local', 'Content-Type': 'application/json', 'Idempotency-Key': 'memory-task',
    },
    body: JSON.stringify({ workspace: 'project', text: 'Summarize notes', usePersonalMemory: true }),
  });
  assert.equal(created.status, 202);
  const task = await created.json();
  await expectNoLegacyAssignment();
  assert.equal(await client.runOnce(AbortSignal.timeout(5000)), true);
  assert.equal(store.get('owner', task.id)?.result, 'Fixture summary');
  assert.equal(store.snapshot('owner').artifacts.length, 1);
  const creation = store.timeline('owner', task.id)!.events.find(event => event.type === 'task.created')!;
  assert.deepEqual(creation.data.memoryInputs, [{ id: note, version: 1 }]);
  assert.doesNotMatch(JSON.stringify(creation.data), /Prefer notes in bullet points/);
  const presence = store.devices('owner').find(item => item.id === device.id)!;
  assert.equal(presence.workerLabel, 'Fixture JSONL');
  assert.equal(presence.workerProtocol, 'jsonl');
  const execution = () => store.timeline('owner', task.id)!.events.find(event => event.type === 'run.started')!.data.worker;
  const workerReceipt = execution();
  assert.equal(workerReceipt.label, 'Fixture JSONL');
  assert.equal(workerReceipt.protocol, 'jsonl');
  assert.equal(workerReceipt.adapterVersion, 1);
  assert.match(workerReceipt.revision, /^[a-f0-9]{64}$/);
  assert.equal(presence.workerRevision, workerReceipt.revision);
  assert.equal(presence.workerAdapterVersion, 1);
  assert(!JSON.stringify(workerReceipt).includes(script));
  store.recordDeviceWorker(device.id, { label: 'Later worker', protocol: 'acp' });
  assert.equal(store.devices('owner').find(item => item.id === device.id)?.workerRevision, null);
  assert.deepEqual(execution(), workerReceipt);
  const progress = store.events('owner', 0).filter(event => event.type === 'run.progress')
    .map(event => JSON.parse(event.data).message);
  assert.deepEqual(progress, ['Running Fixture JSONL', 'Read the input']);
  const workflow = store.createWorkflow('owner', 'full-input', 'project', [
    { key: 'source', goal: 'Prepare full file', needs: [] },
    { key: 'verify', goal: 'Verify upstream file', needs: ['source'], workerCapability: 'full-input-artifacts', acceptanceCriteria: ['Check the full input'] },
  ]);
  const draft = store.claim('owner', 'project', device.id, Date.now(), 45_000)!;
  assert.equal(store.finish(draft.run.id, device.id, Date.now(), {
    status: 'succeeded', result: 'Prepared', artifact: { name: 'source.md', text: 'Z'.repeat(2500) },
  }), true);
  assert.equal(await client.runOnce(AbortSignal.timeout(4000)), true);
  const verified = workflow.steps.find(step => step.key === 'verify')!;
  assert.equal(store.get('owner', String(verified.taskId))?.result, 'Complete input verified');
  assert.equal(store.snapshot('owner').criteria[0].criterion, 'Check the full input');
  assert.deepEqual(store.snapshot('another').criteria, []);

  const sources = ['one', 'two', 'three'];
  const oversized = store.createWorkflow('owner', 'oversized-full-input', 'project', [
    ...sources.map(key => ({ key, goal: 'Prepare ' + key, needs: [] })),
    { key: 'verify', goal: 'Verify oversized handoff', needs: sources, workerCapability: 'full-input-artifacts' },
  ]);
  for (const key of sources) {
    const source = store.claim('owner', 'project', device.id, Date.now(), 45_000)!;
    assert.equal(source.task.goal, 'Prepare ' + key);
    assert.ok(store.finish(source.run.id, device.id, Date.now(), {
      status: 'succeeded', result: 'Prepared', artifact: { name: key + '.txt', text: 'X'.repeat(24_000) },
    }));
  }
  assert.equal(await client.runOnce(AbortSignal.timeout(4000)), true);
  const rejected = store.get('owner', String(oversized.steps.find(step => step.key === 'verify')!.taskId));
  assert.equal(rejected?.status, 'failed');
  assert.match(rejected?.result ?? '', /artifacts exceed the device input budget/);

  const pausable = store.create('owner', 'fixture', 'pause-task', 'project', 'Wait for pause');
  const signal = AbortSignal.timeout(4000);
  const executing = assert.rejects(client.runOnce(signal), /aborted/i);
  while (!store.timeline('owner', pausable.id)?.events.some(event => event.data.message === 'Ready to pause')) {
    await delay(10, undefined, { signal });
  }
  const paused = await fetch('http://127.0.0.1:' + address.port + '/v1/tasks/' + pausable.id + '/commands', {
    method: 'POST', signal, headers: {
      Authorization: 'Bearer local', 'Content-Type': 'application/json', 'Idempotency-Key': 'pause',
    },
    body: JSON.stringify({ action: 'pause', expectedVersion: 1 }),
  });
  assert.equal(paused.status, 200);
  await executing;
  assert.equal(store.get('owner', pausable.id)?.status, 'paused');

  const revisable = store.create('owner', 'fixture', 'revisable', 'project', 'Wait for follow-up');
  const revisionSignal = AbortSignal.timeout(5_000);
  const oldRun = assert.rejects(client.runOnce(revisionSignal), /aborted/i);
  while (!store.timeline('owner', revisable.id)?.events.some(event => event.data.message === 'Ready to pause')) {
    await delay(10, undefined, { signal: revisionSignal });
  }
  const appended = await fetch('http://127.0.0.1:' + address.port + '/v1/tasks/' + revisable.id + '/commands', {
    method: 'POST', signal: revisionSignal, headers: {
      Authorization: 'Bearer local', 'Content-Type': 'application/json', 'Idempotency-Key': 'append',
    },
    body: JSON.stringify({ action: 'append', expectedVersion: 1, text: 'Use the updated instructions' }),
  });
  assert.equal(appended.status, 200);
  await oldRun;
  assert.equal(store.get('owner', revisable.id)?.status, 'queued');
  assert.equal(await client.runOnce(revisionSignal), true);
  assert.equal(store.get('owner', revisable.id)?.result, 'Use the updated instructions');

  const retryTask = store.create('owner', 'fixture', 'retry-history', 'project', 'Recover a failed attempt');
  assert.equal(await client.runOnce(AbortSignal.timeout(5_000)), true);
  assert.equal(store.get('owner', retryTask.id)?.status, 'failed');
  assert.equal(store.command('owner', retryTask.id, 1, { action: 'retry' })?.version, 2);
  assert.equal(await client.runOnce(AbortSignal.timeout(5_000)), true);
  assert.equal(store.get('owner', retryTask.id)?.result, 'Previous attempt identified');

  const connection = memory.connect('owner', 'github', 'Handbook', 'project');
  const source = { connection, resource: 'guide.md', revision: '1' };
  memory.importDocument('owner', 'project', 'Private review template', source);
  const base = 'http://127.0.0.1:' + address.port;
  const createAttachmentTask = (key: string, attachments: { name: string; text: string }[]) => fetch(base + '/v1/events', {
    method: 'POST', headers: {
      Authorization: 'Bearer local', 'Content-Type': 'application/json', 'Idempotency-Key': key,
    }, body: JSON.stringify({ workspace: 'project', text: 'Inspect the attachment', attachments }),
  });
  const removedNote = memory.remember('owner', 'project', 'Forecast assumptions for the task')!;
  const personalResponse = await fetch(base + '/v1/events', {
    method: 'POST', headers: {
      Authorization: 'Bearer local', 'Content-Type': 'application/json', 'Idempotency-Key': 'removed-personal-note',
    }, body: JSON.stringify({ workspace: 'project', text: 'Forecast assumptions', usePersonalMemory: true }),
  });
  assert.equal(personalResponse.status, 202);
  const personalTask = await personalResponse.json();
  assert.deepEqual(store.timeline('owner', personalTask.id)?.events[0].data.memoryInputs, [{ id: removedNote, version: 1 }]);
  assert.equal(memory.remove('owner', removedNote), true);
  assert.equal(await client.runOnce(AbortSignal.timeout(5_000)), false);
  assert.equal(store.get('owner', personalTask.id)?.status, 'waiting_user');
  const activeNote = memory.remember('owner', 'project', 'Forecast input active')!;
  const activePersonalResponse = await fetch(base + '/v1/events', {
    method: 'POST', headers: {
      Authorization: 'Bearer local', 'Content-Type': 'application/json', 'Idempotency-Key': 'active-personal-note',
    }, body: JSON.stringify({ workspace: 'project', text: 'Wait with the forecast', usePersonalMemory: true }),
  });
  assert.equal(activePersonalResponse.status, 202);
  const activePersonal = await activePersonalResponse.json();
  const abortPersonal = AbortSignal.timeout(5_000);
  const stoppedPersonal = assert.rejects(client.runOnce(abortPersonal), /aborted/i);
  while (!store.timeline('owner', activePersonal.id)?.events.some(event => event.data.message === 'Forecast input loaded')) {
    await delay(10, undefined, { signal: abortPersonal });
  }
  assert.equal((await fetch(base + '/v1/memory/' + activeNote, {
    method: 'DELETE', headers: { Authorization: 'Bearer local' },
  })).status, 200);
  await stoppedPersonal;
  assert.equal(store.get('owner', activePersonal.id)?.status, 'waiting_user');
  const stopEvents = store.timeline('owner', activePersonal.id)?.events.filter(event => event.type === 'run.memory_access_changed');
  assert.equal(stopEvents?.length, 1);
  assert.equal(store.runTaskId(String(stopEvents?.[0]?.data.runId), device.id), undefined);
  const attachment = { name: 'notes.txt', text: 'Attachment fixture body' };
  assert.equal((await createAttachmentTask('path-attachment', [{ ...attachment, name: '../notes.txt' }])).status, 400);
  assert.equal((await createAttachmentTask('large-attachment', [{ ...attachment, text: 'a'.repeat(8193) }])).status, 400);
  const attachmentResponse = await createAttachmentTask('valid-attachment', [attachment]);
  assert.equal(attachmentResponse.status, 202);
  const attachedTask = await attachmentResponse.json();
  assert.equal((await (await createAttachmentTask('valid-attachment', [attachment])).json()).id, attachedTask.id);
  assert.equal((await createAttachmentTask('valid-attachment', [{ ...attachment, text: 'Changed' }])).status, 409);
  await expectNoLegacyAssignment();
  assert.equal(await client.runOnce(AbortSignal.timeout(5_000)), true);
  assert.equal(store.get('owner', attachedTask.id)?.result, 'Attachment verified');
  const attachedEvent = store.timeline('owner', attachedTask.id)?.events.find(event => event.type === 'task.created');
  assert.equal(attachedEvent?.data.attachments[0].name, attachment.name);
  assert.doesNotMatch(JSON.stringify(attachedEvent), /Attachment fixture body/);
  const attachmentPath = '/v1/tasks/' + attachedTask.id + '/attachments/0';
  const readAttachments = async (token: string) => (await (await fetch(base + '/v1/state', {
    headers: { Authorization: 'Bearer ' + token },
  })).json()).attachments;
  const readAttachment = (path: string, token: string) => fetch(base + path, {
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.deepEqual((await readAttachments('local')).filter((item: { taskId: string }) => item.taskId === attachedTask.id),
    [{ taskId: attachedTask.id, position: 0, name: attachment.name, size: Buffer.byteLength(attachment.text) }]);
  assert.deepEqual(await (await readAttachment(attachmentPath, 'local')).json(), attachment);
  assert.equal((await readAttachment(attachmentPath, 'wrong')).status, 401);
  assert.equal(store.taskAttachment('another-owner', attachedTask.id, 0), undefined);

  const createWithEvidence = (key: string, sourceId = connection, goal = 'Use the review template', attachments?: { name: string; text: string }[]) => fetch(base + '/v1/events', {
    method: 'POST', headers: {
      Authorization: 'Bearer local', 'Content-Type': 'application/json', 'Idempotency-Key': key,
    }, body: JSON.stringify({ workspace: 'project', text: goal, attachments,
      appMemory: { query: 'review', sources: [sourceId] } }),
  });
  const creationWithEvidence = await createWithEvidence('app-evidence', connection, 'Use the review template', [attachment]);
  assert.equal(creationWithEvidence.status, 202);
  const protectedTask = await creationWithEvidence.json();
  await expectNoLegacyAssignment();
  assert.equal(store.get('owner', protectedTask.id)?.status, 'queued');
  assert.equal(store.timeline('owner', protectedTask.id)?.events.some(event => event.type === 'run.started'), false);
  store.recordDeviceActivity(device.id, Date.now(), 'document.preview');
  store.updateDeviceReadiness(Date.now());
  assert.equal(store.get('owner', protectedTask.id)?.status, 'waiting_device');

  assert.equal(await client.runOnce(AbortSignal.timeout(5_000)), true);
  const file = store.snapshot('owner').artifacts.find(item => item.taskId === protectedTask.id)!;
  const download = (token: string) => fetch(base + '/v1/artifacts/' + file.id, {
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.equal(await (await download('local')).text(), 'Private review template');
  const audit = async () => (await fetch(base + '/v1/admin/audit-export', {
    headers: { Authorization: 'Bearer local' },
  })).json();
  assert.ok((await audit()).events.some((event: { taskId: string; data: { result?: string } }) =>
    event.taskId === protectedTask.id && event.data.result === 'Private review template'));
  const pairing = store.createPairing('owner', Date.now());
  const phone = store.redeemPairing(pairing.code, 'Phone', Date.now())!;
  assert.equal((await download(phone.token)).status, 404);
  const converse = (token: string, key: string, text: string) => fetch(base + '/v1/conversation', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ workspace: 'project', text }),
  });
  assert.equal((await converse('local', 'protected-model-lookup', 'Find the review task')).status, 200);
  assert.equal(routedTaskCount, 0);
  const statusText = '/status Use the review template';
  assert.match((await (await converse('local', 'protected-admin-status', statusText)).json()).text, /Use the review template/);
  assert.equal((await (await converse(phone.token, 'protected-admin-status', statusText)).json()).text, 'No matching tasks.');

  const sharePath = base + '/v1/tasks/' + protectedTask.id + '/share-result';
  const setShare = (enabled: boolean, version = 1, token = 'local') => fetch(sharePath, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: phone.id, expectedVersion: version, enabled }),
  });
  assert.equal((await setShare(true, 2)).status, 409);
  assert.equal((await setShare(true, 1, phone.token)).status, 403);
  assert.equal((await setShare(true)).status, 200);
  assert.equal(await (await download(phone.token)).text(), 'Private review template');
  const protectedAttachmentPath = '/v1/tasks/' + protectedTask.id + '/attachments/0';
  assert.equal((await readAttachment(protectedAttachmentPath, 'local')).status, 200);
  assert.equal((await readAttachment(protectedAttachmentPath, phone.token)).status, 404);
  assert.ok(!(await readAttachments(phone.token)).some((item: { taskId: string }) => item.taskId === protectedTask.id));
  assert.equal((await readAttachment(attachmentPath, phone.token)).status, 200);
  const otherPairing = store.createPairing('owner', Date.now());
  const otherPhone = store.redeemPairing(otherPairing.code, 'Other phone', Date.now())!;
  assert.equal((await download(otherPhone.token)).status, 404);
  const phoneState = await (await fetch(base + '/v1/state', { headers: { Authorization: 'Bearer ' + phone.token } })).json();
  assert.equal(phoneState.tasks.find((item: { id: string }) => item.id === protectedTask.id)?.result, 'Private review template');
  assert.equal(phoneState.tasks.find((item: { id: string }) => item.id === protectedTask.id)?.goal, 'Application-backed task');
  const conflict = await fetch(base + '/v1/tasks/' + protectedTask.id + '/commands', {
    method: 'POST', headers: {
      Authorization: 'Bearer ' + phone.token, 'Content-Type': 'application/json', 'Idempotency-Key': 'protected-conflict',
    }, body: JSON.stringify({ action: 'pause', expectedVersion: 999 }),
  });
  assert.equal(conflict.status, 409);
  const conflictTask = (await conflict.json()).task;
  assert.equal(conflictTask.goal, 'Application-backed task');
  assert.equal(conflictTask.result, null);
  assert.equal((await fetch(base + '/v1/tasks/' + protectedTask.id + '/timeline', {
    headers: { Authorization: 'Bearer ' + phone.token },
  })).status, 404);
  assert.equal((await setShare(false)).status, 200);
  assert.equal((await download(phone.token)).status, 404);
  assert.equal((await setShare(true)).status, 200);
  const activeResponse = await createWithEvidence('active-app-evidence');
  const activeTask = await activeResponse.json();
  const devicePost = (path: string, body: object) => fetch(base + '/v1/device/' + path, {
    method: 'POST', headers: { Authorization: 'Bearer ' + device.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const claimInput = { capability: 'agent.acp', requestId: '31415926-5358-4979-8238-462643383279' };
  const claimed = await (await devicePost('claim', claimInput)).json();
  const replayed = await (await devicePost('claim', claimInput)).json();
  assert.equal(replayed.assignment.run.id, claimed.assignment.run.id);
  assert.equal(replayed.assignment.replayed, undefined);
  assert.equal(claimed.assignment.task.id, activeTask.id);
  assert.equal(claimed.assignment.memoryInputs[0].body, 'Private review template');
  assert.equal(claimed.assignment.memoryInputs[0].connection, undefined);
  const usageUrl = base + '/v1/app-connections/' + connection + '/usage';
  const readUsage = () => fetch(usageUrl, { headers: { Authorization: 'Bearer local' } });
  assert.equal((await fetch(usageUrl, { headers: { Authorization: 'Bearer ' + phone.token } })).status, 403);
  const usage = (await (await readUsage()).json()).usage;
  const workerUsage = usage.filter((entry: { operation: string }) => entry.operation === 'worker_memory');
  assert.equal(workerUsage.length, 2);
  assert.deepEqual(new Set(workerUsage.map((entry: { taskId: string }) => entry.taskId)),
    new Set([protectedTask.id, activeTask.id]));
  assert.ok(workerUsage.every((entry: { status: string }) => entry.status === 'authorized'));
  assert.doesNotMatch(JSON.stringify(usage), /Private review template|guide\.md/);
  const pendingResponse = await createWithEvidence('queued-app-evidence');
  assert.equal(pendingResponse.status, 202);
  const pending = await pendingResponse.json();
  assert.equal(memory.disconnect('owner', connection), true);
  const revokedReplay = await devicePost('claim', claimInput);
  assert.equal(revokedReplay.status, 200);
  assert.deepEqual(await revokedReplay.json(), { assignment: null });
  const activeRunId = claimed.assignment.run.id;
  assert.equal(store.runTaskId(activeRunId, device.id), activeTask.id);
  assert.ok(store.deviceStopTargets(device.id).some(item => item.id === activeRunId));
  assert.equal((await devicePost('runs/' + activeRunId + '/stopped', {})).status, 200);
  assert.equal(store.runTaskId(activeRunId, device.id), undefined);
  assert.equal((await (await readUsage()).json()).usage.filter((entry: { operation: string }) =>
    entry.operation === 'worker_memory').length, 2);
  assert.equal((await devicePost('runs/' + claimed.assignment.run.id + '/finish', {
    status: 'succeeded', result: 'Private review template',
  })).status, 409);
  assert.equal(store.get('owner', activeTask.id)?.status, 'waiting_user');
  assert.equal(await client.runOnce(AbortSignal.timeout(5_000)), false);
  assert.equal(store.get('owner', pending.id)?.status, 'waiting_user');
  assert.equal((await download('local')).status, 404);
  assert.equal((await readAttachment(protectedAttachmentPath, 'local')).status, 404);
  assert.equal((await download(phone.token)).status, 404);
  const hidden = await (await fetch(base + '/v1/state', { headers: { Authorization: 'Bearer local' } })).json();
  assert.equal(hidden.tasks.find((item: { id: string }) => item.id === protectedTask.id)?.result, null);
  assert.equal(hidden.tasks.find((item: { id: string }) => item.id === protectedTask.id)?.appMemoryUnavailable, true);
  const phoneAfterRevocation = await (await fetch(base + '/v1/state', {
    headers: { Authorization: 'Bearer ' + phone.token },
  })).json();
  assert.equal(phoneAfterRevocation.tasks.find((item: { id: string }) => item.id === protectedTask.id)?.appMemoryUnavailable,
    undefined);

  assert.equal((await (await converse('local', 'protected-admin-status', statusText)).json()).text, 'No matching tasks.');
  const protectedEvents = (await audit()).events.filter((event: { taskId: string }) => event.taskId === protectedTask.id);
  assert.ok(protectedEvents.length > 0);
  assert.ok(protectedEvents.every((event: { data: object }) => Object.keys(event.data).length === 0));

  const liveConnection = memory.connect('owner', 'github', 'Live handbook', 'project');
  memory.importDocument('owner', 'project', 'Private review template', { ...source, connection: liveConnection });
  const liveResponse = await createWithEvidence('live-revocation', liveConnection, 'Wait with the review template');
  assert.equal(liveResponse.status, 202);
  const liveTask = await liveResponse.json();
  const revokeSignal = AbortSignal.timeout(5_000);
  const revokedRun = assert.rejects(client.runOnce(revokeSignal), /aborted/i);
  while (!store.timeline('owner', liveTask.id)?.events.some(event => event.data.message === 'Review template loaded')) {
    await delay(10, undefined, { signal: revokeSignal });
  }
  const revoked = await fetch(base + '/v1/app-connections/' + liveConnection, {
    method: 'DELETE', signal: revokeSignal, headers: { Authorization: 'Bearer local' },
  });
  assert.equal(revoked.status, 200);
  await revokedRun;
  assert.equal(store.get('owner', liveTask.id)?.status, 'waiting_user');
  const evidenceEvents = store.timeline('owner', liveTask.id)?.events.filter(event => event.type === 'run.memory_access_changed');
  assert.equal(evidenceEvents?.length, 1);
  assert.equal(typeof evidenceEvents[0].data.runId, 'string');
  assert.equal(store.runTaskId(String(evidenceEvents[0].data.runId), device.id), undefined);

  const workflowConnection = memory.connect('owner', 'github', 'Workflow handbook', 'project');
  memory.importDocument('owner', 'project', 'Private review template', { ...source, connection: workflowConnection });
  const workflowRequest = (token: string) => fetch(base + '/v1/workflows', {
    method: 'POST', headers: {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': 'app-workflow',
    },
    body: JSON.stringify({
      workspace: 'project', appMemory: { query: 'review', sources: [workflowConnection] },
      steps: [
        { key: 'draft', goal: 'Use the review template', needs: [], acceptanceCriteria: ['Use the private review format'] },
        { key: 'review', goal: 'Review the preceding draft', needs: ['draft'] },
        { key: 'finalize', goal: 'Review the preceding draft', needs: ['review'] },
      ],
    }),
  });
  assert.equal((await workflowRequest(phone.token)).status, 403);
  const workflowResponse = await workflowRequest('local');
  assert.equal(workflowResponse.status, 202);
  const appWorkflow = await workflowResponse.json();
  assert.deepEqual(await (await workflowRequest('local')).json(), appWorkflow);
  const workflowTasks = appWorkflow.steps.map((step: { taskId: string }) => step.taskId);
  const readState = async (token: string) => (await (await fetch(base + '/v1/state', {
    headers: { Authorization: 'Bearer ' + token },
  })).json());
  const protectedWorkflowState = await readState(phone.token);
  assert.ok(protectedWorkflowState.tasks.filter((item: { id: string }) => workflowTasks.includes(item.id))
    .every((item: { goal: string }) => item.goal === 'Application-backed task'));
  assert.ok(!protectedWorkflowState.criteria.some((item: { taskId: string }) => workflowTasks.includes(item.taskId)));
  assert.ok(!protectedWorkflowState.workflowSteps.some((item: { taskId: string }) => workflowTasks.includes(item.taskId)));
  const adminWorkflowState = await readState('local');
  assert.ok(adminWorkflowState.criteria.some((item: { criterion: string }) => item.criterion === 'Use the private review format'));
  assert.equal(await client.runOnce(AbortSignal.timeout(5_000)), true);
  assert.equal(await client.runOnce(AbortSignal.timeout(5_000)), true);
  const workflowArtifacts = store.snapshot('owner').artifacts.filter(item => workflowTasks.includes(item.taskId));
  assert.equal(workflowArtifacts.length, 2);
  const workflowDownload = (id: string) => fetch(base + '/v1/artifacts/' + id, { headers: { Authorization: 'Bearer local' } });
  for (const artifact of workflowArtifacts) assert.equal(await (await workflowDownload(String(artifact.id))).text(), 'Private review template');
  assert.equal((await fetch(base + '/v1/app-connections/' + workflowConnection, {
    method: 'DELETE', headers: { Authorization: 'Bearer local' },
  })).status, 200);
  assert.equal(store.get('owner', workflowTasks[2])?.status, 'waiting_user');
  const blockedEvents = store.timeline('owner', workflowTasks[2])?.events;
  assert.ok(blockedEvents?.some(event => event.type === 'task.memory_access_changed'));
  assert.ok(!blockedEvents?.some(event => event.type === 'run.started'));
  for (const artifact of workflowArtifacts) assert.equal((await workflowDownload(String(artifact.id))).status, 404);
  assert.equal(await client.runOnce(AbortSignal.timeout(5_000)), false);
  assert.equal(store.get('owner', workflowTasks[2])?.status, 'waiting_user');

  const recoveryConnection = memory.connect('owner', 'github', 'Recovery handbook', 'project');
  memory.importDocument('owner', 'project', 'Private review template', { ...source, connection: recoveryConnection });
  const recoveryResponse = await createWithEvidence('recoverable-evidence', recoveryConnection);
  assert.equal(recoveryResponse.status, 202);
  const recoveryTask = await recoveryResponse.json();
  const changeScope = (workspace: string) => fetch(base + '/v1/app-connections/' + recoveryConnection, {
    method: 'PATCH', headers: { Authorization: 'Bearer local', 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace }),
  });
  const retry = () => fetch(base + '/v1/tasks/' + recoveryTask.id + '/commands', {
    method: 'POST', headers: {
      Authorization: 'Bearer local', 'Content-Type': 'application/json', 'Idempotency-Key': 'retry-evidence',
    }, body: JSON.stringify({ action: 'retry', expectedVersion: 1 }),
  });
  const linkCode = store.createTaskLink('owner', recoveryTask.id, Date.now())!;
  const channelMessage = (id: string, text: string, root = false) =>
    store.receiveChannelMessage('owner', 'feishu', 'project', { id, text, root, chat: 'chat', thread: 'thread' });
  channelMessage('link', '/link ' + linkCode.code, true);
  assert.equal(store.taskChannels('owner', recoveryTask.id).length, 1);
  assert.equal((await changeScope('another-project')).status, 200);
  assert.equal(store.get('owner', recoveryTask.id)?.status, 'waiting_user');
  assert.equal((await retry()).status, 409);
  channelMessage('revoked-follow-up', 'Start the task again');
  channelMessage('status', '/status');
  assert.equal(store.get('owner', recoveryTask.id)?.status, 'waiting_user');
  assert.equal(store.get('owner', recoveryTask.id)?.version, 1);
  assert.equal((await changeScope('project')).status, 200);
  const restoredState = await (await fetch(base + '/v1/state', { headers: { Authorization: 'Bearer local' } })).json();
  assert.equal(restoredState.tasks.find((item: { id: string }) => item.id === recoveryTask.id)?.appMemoryUnavailable, undefined);
  assert.equal((await retry()).status, 200);
  assert.equal(await client.runOnce(AbortSignal.timeout(5_000)), true);
  assert.equal(store.get('owner', recoveryTask.id)?.result, 'Private review template');
  assert.equal(store.get('owner', recoveryTask.id)?.version, 2);
  channelMessage('authorized-follow-up', 'Use the original format');
  assert.equal(store.get('owner', recoveryTask.id)?.version, 3);
  assert.equal(store.get('owner', recoveryTask.id)?.status, 'queued');
  assert.equal((await changeScope('another-project')).status, 200);
  channelMessage('pause-while-revoked', '/pause');
  assert.equal(store.get('owner', recoveryTask.id)?.status, 'paused');
  channelMessage('resume-while-revoked', '/resume');
  assert.equal(store.get('owner', recoveryTask.id)?.status, 'paused');
  assert.equal((await changeScope('project')).status, 200);
  channelMessage('resume-after-restore', '/resume');
  assert.equal(store.get('owner', recoveryTask.id)?.status, 'queued');
  const priorVersion = store.get('owner', recoveryTask.id)?.version;
  memory.importDocument('owner', 'project', 'New review template',
    { ...source, connection: recoveryConnection, revision: '2' });
  server.flushStopNotifications();
  assert.equal(store.get('owner', recoveryTask.id)?.status, 'waiting_user');
  assert.equal(store.get('owner', recoveryTask.id)?.version, priorVersion);
  assert.equal(await client.runOnce(AbortSignal.timeout(5_000)), false);

  const copyTask = (key: string, data: object, token = 'local') => fetch(base + '/v1/events', {
    method: 'POST', headers: {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': key,
    }, body: JSON.stringify({
      workspace: 'project', text: 'Use the new review template', copiedFromTask: recoveryTask.id, ...data,
    }),
  });
  assert.equal((await copyTask('copy-by-phone', {}, phone.token)).status, 403);
  assert.equal((await copyTask('copy-other-workspace', { workspace: 'another-project' })).status, 404);
  assert.equal((await copyTask('copy-without-evidence', {})).status, 400);
  const copyInput = { appMemory: { query: 'review', sources: [recoveryConnection] } };
  const copied = await copyTask('copy-with-current-evidence', copyInput);
  assert.equal(copied.status, 202);
  const fresh = await copied.json();
  assert.notEqual(fresh.id, recoveryTask.id);
  assert.equal((await (await copyTask('copy-with-current-evidence', copyInput)).json()).id, fresh.id);
  assert.equal(store.timeline('owner', fresh.id)?.events[0].data.copiedFromTask, recoveryTask.id);
  assert.equal(store.get('owner', recoveryTask.id)?.version, priorVersion);
  assert.deepEqual(store.appEvidence(fresh.id)?.map(item => item.id),
    memory.recall('owner', 'project', 'review', [recoveryConnection], false, false).map(item => item.id));

  const personalArtifact = store.snapshot('owner').artifacts.find(item => item.taskId === task.id)!;
  const personalArtifactPath = '/v1/artifacts/' + personalArtifact.id;
  assert.equal((await readAttachment(personalArtifactPath, phone.token)).status, 200);
  assert.equal((await readState(phone.token)).tasks.find((item: { id: string }) =>
    item.id === task.id)?.personalMemoryUnavailable, undefined);
  const rememberDerived = await fetch(base + '/v1/tasks/' + task.id + '/remember-result', {
    method: 'POST', headers: { Authorization: 'Bearer local', 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 1 }),
  });
  assert.equal(rememberDerived.status, 409);
  assert.equal(memory.remove('owner', note), true);
  assert.equal((await readAttachment(personalArtifactPath, 'local')).status, 404);
  assert.equal((await readAttachment(personalArtifactPath, phone.token)).status, 404);
  assert.equal((await readAttachment('/v1/tasks/' + task.id + '/timeline', 'local')).status, 404);
  const stateAfterMemoryRemoval = await readState(phone.token);
  assert.equal(stateAfterMemoryRemoval.tasks.find((item: { id: string }) => item.id === task.id)?.result, null);
  assert.equal(stateAfterMemoryRemoval.tasks.find((item: { id: string }) => item.id === task.id)?.personalMemoryUnavailable, true);
  assert.ok(!stateAfterMemoryRemoval.artifacts.some((item: { id: string }) => item.id === personalArtifact.id));
});

test('JSONL rejects duplicate terminal events and stops a cancelled subprocess', async () => {
  const job = { goal: 'Summarize notes', instructions: [], predecessors: [] };
  const run = (script: string, signal: AbortSignal) => runCustomJsonl({
    executable: process.execPath, args: ['-e', script], label: 'Fixture', protocol: 'jsonl',
  }, tmpdir(), job, signal, async () => {});
  await assert.rejects(run(`
    const line = JSON.stringify({version:1,type:'completed',result:'done'});
    console.log(line); console.log(line);
  `, AbortSignal.timeout(3000)), /event sequence/);
  await assert.rejects(run('setInterval(() => {}, 1000)', AbortSignal.timeout(150)), /aborted|timeout/i);
});
