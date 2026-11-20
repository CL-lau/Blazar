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
import { TaskStore } from './store.ts';

test('a registered JSONL extension executes a real subprocess through Router and DeviceClient', async t => {
  const root = await mkdtemp(join(tmpdir(), 'blazar-extension-'));
  const script = join(root, 'worker.cjs');
  await writeFile(script, `
    const request = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
    if (request.version !== 1 || request.type !== 'run') process.exit(2);
    if (request.input.goal === 'Verify upstream file') {
      const artifact = request.input.predecessorResults[0].artifact;
      if (artifact.text !== 'Z'.repeat(2500) || artifact.excerpt.length !== 2000 ||
          request.input.acceptanceCriteria?.[0] !== 'Check the full input') process.exit(3);
      console.log(JSON.stringify({version:1,type:'completed',result:'Complete input verified'}));
      return;
    }
    if (request.input.goal === 'Wait for pause') {
      console.log(JSON.stringify({version:1,type:'progress',message:'Ready to pause'}));
      setInterval(() => {}, 1000);
      return;
    }
    if (request.input.goal !== 'Summarize notes') process.exit(2);
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
  const store = new TaskStore(':memory:');
  const ledger = new DeviceLedger(':memory:');
  const server = routerServer(store, { owner: 'owner', token: 'local' });
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
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const task = store.create('owner', 'fixture', 'task', 'project', 'Summarize notes');
  assert.equal(await client.runOnce(AbortSignal.timeout(5000)), true);
  assert.equal(store.get('owner', task.id)?.result, 'Fixture summary');
  assert.equal(store.snapshot('owner').artifacts.length, 1);
  const presence = store.devices('owner')[0];
  assert.equal(presence.workerLabel, 'Fixture JSONL');
  assert.equal(presence.workerProtocol, 'jsonl');
  const execution = () => store.timeline('owner', task.id)!.events.find(event => event.type === 'run.started')!.data.worker;
  const workerReceipt = execution();
  assert.equal(workerReceipt.label, 'Fixture JSONL');
  assert.equal(workerReceipt.protocol, 'jsonl');
  assert.equal(workerReceipt.adapterVersion, 1);
  assert.match(workerReceipt.revision, /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(workerReceipt).includes(script));
  store.recordDeviceWorker(device.id, { label: 'Later worker', protocol: 'acp' });
  assert.deepEqual(execution(), workerReceipt);
  const progress = store.events('owner', 0).filter(event => event.type === 'run.progress')
    .map(event => JSON.parse(event.data).message);
  assert.deepEqual(progress, ['Running Fixture JSONL', 'Read the input']);
  const workflow = store.createWorkflow('owner', 'full-input', 'project', [
    { key: 'source', goal: 'Prepare full file', needs: [] },
    { key: 'verify', goal: 'Verify upstream file', needs: ['source'], acceptanceCriteria: ['Check the full input'] },
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
