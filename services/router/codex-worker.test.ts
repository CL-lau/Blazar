import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceClient } from '../device/client.ts';
import { DeviceLedger } from '../device/ledger.ts';
import { routerServer } from './http.ts';
import { TaskStore } from './store.ts';
import { runCodex } from '../../packages/workers/codex.ts';

test('Codex correlates stream events with the started turn even before the RPC response', async () => {
  const worker = {
    executable: process.execPath, label: 'Codex protocol fixture',
    args: ['-e', String.raw`
      const { createInterface } = require('node:readline');
      const send = packet => process.stdout.write(JSON.stringify(packet) + '\n');
      createInterface({ input: process.stdin }).on('line', line => {
        const { id, method, params } = JSON.parse(line);
        const reply = result => send({ id, result });
        const notify = (method, params) => send({ method, params: { threadId: 'thread', ...params } });
        if (method === 'initialize') reply({});
        if (method === 'thread/start') {
          if (params.sandbox !== 'read-only' || params.approvalPolicy !== 'never') process.exit(2);
          reply({ thread: { id: 'thread' }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never' });
        }
        if (method === 'turn/start') {
          notify('item/agentMessage/delta', { turnId: 'other', delta: 'Unrelated' });
          notify('turn/completed', { turn: { id: 'other', status: 'completed' } });
          notify('item/agentMessage/delta', { turnId: 'active', delta: 'Early ' });
          reply({ turn: { id: 'active' } });
          notify('item/agentMessage/delta', { turnId: 'active', delta: 'reply' });
          notify('turn/completed', { turn: { id: 'active', status: 'completed' } });
        }
      });
    `],
  };
  const job = { goal: 'Review the notes', instructions: [], predecessors: [] };
  assert.equal(await runCodex(worker, process.cwd(), job, AbortSignal.timeout(3_000)), 'Early reply');
});

test('Codex refuses to start a turn when the server reports a writable sandbox', async () => {
  const worker = {
    executable: process.execPath, label: 'Writable Codex fixture',
    args: ['-e', `
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const { id, method } = JSON.parse(line);
        if (method === 'initialize') console.log(JSON.stringify({ id, result: {} }));
        if (method === 'thread/start') console.log(JSON.stringify({ id, result: {
          thread: { id: 'thread' }, sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'never',
        } }));
        if (method === 'turn/start') process.exit(3);
      });
    `],
  };
  await assert.rejects(runCodex(worker, process.cwd(), { goal: 'Read notes', instructions: [], predecessors: [] },
    AbortSignal.timeout(3_000)), /did not confirm the read-only sandbox/);
});

test('Codex refuses offline tool execution when the server allows tool networking', async () => {
  const worker = {
    executable: process.execPath, label: 'Networked Codex fixture',
    args: ['-e', `
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const { id, method } = JSON.parse(line);
        if (method === 'initialize') console.log(JSON.stringify({ id, result: {} }));
        if (method === 'thread/start') console.log(JSON.stringify({ id, result: {
          thread: { id: 'thread' }, sandbox: { type: 'readOnly', networkAccess: true }, approvalPolicy: 'never',
        } }));
        if (method === 'turn/start') process.exit(3);
      });
    `],
  };
  await assert.rejects(runCodex(worker, process.cwd(), {
    goal: 'Read notes', instructions: [], predecessors: [], offlineToolsRequired: true,
  }, AbortSignal.timeout(3_000)), /tool network access is disabled/);
});

const steeringWorker = {
  executable: process.execPath, label: 'Codex steering fixture', protocol: 'codex' as const,
  args: ['-e', String.raw`
    const assert = require('node:assert/strict');
    const send = packet => process.stdout.write(JSON.stringify(packet) + '\n');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const { id, method, params } = JSON.parse(line);
      const reply = result => send({ id, result });
      if (method === 'initialize') reply({});
      if (method === 'thread/start') {
        assert.equal(params.sandbox, 'read-only');
        assert.equal(params.approvalPolicy, 'never');
        reply({ thread: { id: 'thread' }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' });
      }
      if (method === 'turn/start') reply({ turn: { id: 'active' } });
      if (method === 'turn/steer') {
        assert.equal(params.threadId, 'thread');
        assert.equal(params.expectedTurnId, 'active');
        assert.match(params.clientUserMessageId, /^(message-2|[a-f0-9-]{36}:\d+)$/);
        reply({ turnId: 'active' });
        send({ method: 'item/agentMessage/delta', params: {
          threadId: 'thread', turnId: 'active', delta: params.input[0].text,
        } });
        send({ method: 'turn/completed', params: {
          threadId: 'thread', turn: { id: 'active', status: 'completed' },
        } });
      }
    });
  `],
};
test('Codex steers the active turn with a correlated user message', async () => {
  const job = { goal: 'Review the notes', instructions: [], predecessors: [] };
  const accepted = Promise.withResolvers<boolean>();
  let cleared = false;
  const output = await runCodex(steeringWorker, process.cwd(), job, AbortSignal.timeout(3_000), steer => {
    accepted.resolve(steer('Include the latest notes', 'message-2'));
    return () => { cleared = true; };
  });
  assert.equal(await accepted.promise, true);
  assert.equal(output, 'Include the latest notes');
  assert.equal(cleared, true);
});


test('Router delivers an appended instruction to an active Codex turn and accepts its updated result', async t => {
  const store = new TaskStore(':memory:');
  const ledger = new DeviceLedger(':memory:');
  const server = routerServer(store, { owner: 'owner', token: 'local' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = new URL('http://127.0.0.1:' + address.port);
  const device = store.registerDevice('owner', 'Codex fixture', 'project');
  const client = new DeviceClient(url, device.token, process.cwd(), ledger, steeringWorker);
  t.after(async () => {
    client.close();
    server.closeDeviceSockets();
    await new Promise<void>(resolve => server.close(() => resolve()));
    ledger.close();
    store.close();
  });
  store.createWorkflow('owner', 'steer', 'project', [
    { key: 'review', goal: 'Review the notes', needs: [], workerCapability: 'offline-tools' },
  ]);
  const task = store.snapshot('owner').tasks.find(task => task.goal === 'Review the notes')!;
  assert(task);
  assert.equal(store.claim('owner', 'project', 'alternate', Date.now(), 45_000, '', '/preview ', undefined,
    { protocol: 'jsonl', label: 'Alternative' }), undefined);
  const signal = AbortSignal.timeout(5_000);
  const running = client.runOnce(signal);
  void running.catch(() => {});
  const events = () => store.timeline('owner', task.id)!.events;
  while (!events().some(event => event.type === 'run.steering_ready')) await delay(10, undefined, { signal });
  const appended = await fetch(new URL('/v1/tasks/' + task.id + '/commands', url), {
    method: 'POST', signal, headers: {
      Authorization: 'Bearer local', 'Content-Type': 'application/json', 'Idempotency-Key': 'steer',
    },
    body: JSON.stringify({ action: 'append', expectedVersion: 1, text: 'Include the latest notes' }),
  });
  assert.equal(appended.status, 200);
  assert.equal(await running, true);
  assert.equal(store.get('owner', task.id)?.result, 'Include the latest notes');
  assert.equal(events().filter(event => event.type === 'run.started').length, 1);
  assert.equal(events().find(event => event.type === 'run.instruction_applied')?.data.version, 2);
});

test('Codex verifies worktree write mode and rejects an expanded writable scope', async () => {
  const job = { goal: 'Edit the isolated checkout', instructions: [], predecessors: [], writableWorktreeRequired: true };
  function worker(expanded: boolean) {
    return {
      executable: process.execPath, label: 'Codex worktree fixture',
      args: ['-e', String.raw`
        const assert = require('node:assert/strict');
        const expanded = process.argv[1] === 'true';
        function emit(value) { console.log(JSON.stringify(value)); }
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const { id, method, params } = JSON.parse(line);
          if (method === 'initialize') emit({ id, result: {} });
          if (method === 'thread/start') {
            assert.equal(params.sandbox, 'workspace-write');
            assert.equal(params.approvalPolicy, 'never');
            assert.deepEqual(params.config.sandbox_workspace_write, {
              writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true,
            });
            emit({ id, result: { thread: { id: 'thread' }, cwd: params.cwd, approvalPolicy: 'never',
              sandbox: { type: 'workspaceWrite', writableRoots: expanded ? ['/elsewhere'] : [], networkAccess: false,
                excludeTmpdirEnvVar: true, excludeSlashTmp: true } } });
          }
          if (method === 'turn/start') {
            assert(!expanded);
            emit({ id, result: { turn: { id: 'turn' } } });
            emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'turn', delta: 'Scoped result' } });
            emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
          }
        });
      `, String(expanded)],
    };
  }
  assert.equal(await runCodex(worker(false), process.cwd(), job, AbortSignal.timeout(3_000)), 'Scoped result');
  await assert.rejects(runCodex(worker(true), process.cwd(), job, AbortSignal.timeout(3_000)),
    /did not confirm the isolated worktree write restriction/);
});
