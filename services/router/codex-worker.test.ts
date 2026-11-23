import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gitRunWorktrees, inspectRunWorktree } from '../device/execution/git-worktree.ts';
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

const liveCodex = process.env.BLAZAR_TEST_CODEX_EXECUTABLE;
for (const [protocol, isolated, live] of [
  ['codex', false, false], ['codex', true, false], ['codex-cli', true, false],
  ['codex-cli', true, true],
] as const) {
  test((live ? 'Real ' : '') + protocol + ' persists a completed thread and resumes it ' +
    (isolated ? 'in an isolated checkout' : 'in the shared workspace'), { skip: live && !liveCodex }, async t => {
    const store = new TaskStore(':memory:');
    const server = routerServer(store, { owner: 'owner', token: 'local' });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'blazar-codex-resume-')));
    const root = join(directory, 'repo');
    const state = join(directory, 'state');
    const ledgerPath = join(directory, 'ledger.sqlite');
    const ledger = new DeviceLedger(ledgerPath);
    const checkpoint = (sessionId?: string) => {
      const db = new DatabaseSync(ledgerPath, { readOnly: true });
      try {
        return db.prepare('SELECT session_id,run_id FROM worker_session WHERE ? IS NULL OR session_id=?')
          .get(sessionId ?? null, sessionId ?? null);
      } finally {
        db.close();
      }
    };
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(root);
    writeFileSync(join(root, 'notes.txt'), 'Original\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init');
    git('add', 'notes.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    const worktrees = isolated ? await gitRunWorktrees(root, state, { includePatch: true, allowCodexWrite: true }) : undefined;
    const device = store.registerDevice('owner', 'Codex resume fixture', 'project');
    const client = new DeviceClient(new URL('http://127.0.0.1:' + address.port), device.token, root, ledger, {
      executable: live ? liveCodex! : process.execPath, label: 'Codex resume fixture', protocol,
      args: live ? [] : protocol === 'codex-cli' ? ['-e', String.raw`
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const args = process.argv.slice(1);
        const resumed = args.includes('resume');
        if (resumed) assert(args.includes('saved-thread'));
        const input = JSON.parse(fs.readFileSync(0, 'utf8'));
        if (input.goal === 'Wait for cancellation') {
          fs.writeFileSync(args[0], String(process.pid));
          console.log(JSON.stringify({ type: 'thread.started', thread_id: 'cancel-thread' }));
          setInterval(() => {}, 1000);
        } else {
          assert.deepEqual(input.instructions, resumed ? ['Follow up'] : []);
          assert.equal(fs.readFileSync('notes.txt', 'utf8'), resumed ? 'First change\n' : 'Original\n');
          fs.writeFileSync('notes.txt', resumed ? 'Second change\n' : 'First change\n');
          const send = packet => console.log(JSON.stringify(packet));
          send({ type: 'thread.started', thread_id: 'saved-thread' });
          send({ type: 'item.completed', item: { type: 'agent_message', text: resumed ? 'Resumed' : 'Started' } });
          send({ type: 'turn.completed' });
        }
      `, '--', join(directory, 'cancel-pid')] : ['-e', String.raw`
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const isolated = ${JSON.stringify(isolated)};
        let resumed = false;
        const send = packet => process.stdout.write(JSON.stringify(packet) + '\n');
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const { id, method, params } = JSON.parse(line);
          const reply = result => send({ id, result });
          if (method === 'initialize') reply({});
          if (method === 'thread/start' || method === 'thread/resume') {
            resumed = method === 'thread/resume';
            if (resumed) assert.equal(params.threadId, 'saved-thread');
            else assert.equal(params.ephemeral, false);
            assert.equal(params.sandbox, isolated ? 'workspace-write' : 'read-only');
            assert.equal(params.cwd, process.cwd());
            reply({ cwd: params.cwd, thread: { id: 'saved-thread' }, approvalPolicy: 'never',
              sandbox: isolated ? { type: 'workspaceWrite', writableRoots: [], networkAccess: false,
                excludeTmpdirEnvVar: true, excludeSlashTmp: true } : { type: 'readOnly' } });
          }
          if (method === 'turn/start') {
            const input = JSON.parse(params.input[0].text);
            assert.deepEqual(input.instructions, resumed ? ['Follow up'] : []);
            if (isolated) {
              assert.equal(fs.readFileSync('notes.txt', 'utf8'), resumed ? 'First change\n' : 'Original\n');
              fs.writeFileSync('notes.txt', resumed ? 'Second change\n' : 'First change\n');
            }
            reply({ turn: { id: 'turn' } });
            send({ method: 'item/agentMessage/delta', params: {
              threadId: 'saved-thread', turnId: 'turn', delta: resumed ? 'Resumed' : 'Started',
            } });
            send({ method: 'turn/completed', params: {
              threadId: 'saved-thread', turn: { id: 'turn', status: 'completed' },
            } });
          }
        });
      `],
    }, undefined, root, worktrees);
    t.after(async () => {
      client.close();
      server.closeDeviceSockets();
      await new Promise<void>(resolve => server.close(() => resolve()));
      ledger.close();
      store.close();
    });
    const reviewDevice = protocol === 'codex-cli' && !live ? store.registerDevice('owner', 'Claude review fixture', 'project') : undefined;
    const reviewer = reviewDevice && new DeviceClient(new URL('http://127.0.0.1:' + address.port), reviewDevice.token, root, ledger, {
      executable: process.execPath, label: 'Claude review fixture', protocol: 'claude-cli',
      args: ['-e', String.raw`
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const { predecessorResults } = JSON.parse(fs.readFileSync(0, 'utf8'));
        assert.equal(predecessorResults.length, 1);
        assert.match(predecessorResults[0].artifact.text, /\+First change/);
        assert.equal(fs.readFileSync('notes.txt', 'utf8'), 'Original\n');
        const send = packet => console.log(JSON.stringify(packet));
        send({ type: 'system', subtype: 'init', session_id: 'review-thread' });
        const attemptLog = process.argv[1];
        const retry = fs.existsSync(attemptLog);
        fs.writeFileSync(attemptLog, 'attempted');
        send({ type: 'result', subtype: retry ? 'success' : 'error_during_execution',
          session_id: 'review-thread', is_error: !retry, result: retry ? 'Add a regression test.' : '' });
      `, '--', join(directory, 'review-attempt')],
    });
    t.after(() => reviewer?.close());
    const workflow = store.createWorkflow('owner', 'resume-codex', 'project', [{
      key: 'step', goal: live
        ? 'Set notes.txt to exactly First change followed by a newline, then reply with exactly Started.'
        : 'Read notes', needs: [], workerProtocols: [protocol],
      ...(isolated && { workerCapability: 'writable-worktree', requireReview: !reviewer }),
    }, ...(reviewer ? [{
      key: 'review', goal: 'Review the diff', needs: ['step'], workerProtocols: ['claude-cli'],
      workerCapability: 'full-input-artifacts' as const, requireReview: true, inputArtifacts: { step: 'git-changes.json' },
    }] : [])]);
    const taskId = workflow.steps[0].taskId;
    const runSignal = () => AbortSignal.timeout(live ? 90_000 : 5_000);
    assert.equal(await client.runOnce(runSignal()), true);
    const first = store.get('owner', taskId)!;
    assert.match(first.result ?? '', /^Started\.?$/);
    const firstCheckpoint = checkpoint();
    assert.equal(typeof firstCheckpoint?.session_id, 'string');
    const firstCheckout = isolated
      ? await inspectRunWorktree(root, join(state, 'run-worktrees'), String(firstCheckpoint?.run_id))
      : undefined;
    const firstVersion = isolated && !reviewer ? store.command('owner', taskId, first.version, { action: 'accept_result' })!.version : first.version;
    if (reviewer) {
      const reviewId = workflow.steps[1].taskId;
      assert.equal(await reviewer.runOnce(AbortSignal.timeout(5_000)), true);
      const failedReview = store.get('owner', reviewId)!;
      assert.equal(failedReview.status, 'failed');
      assert.match(failedReview.result ?? '', /Claude Code did not return a completed response/);
      assert.equal(store.command('owner', reviewId, failedReview.version, { action: 'retry' })?.status, 'queued');
      assert.equal(await reviewer.runOnce(AbortSignal.timeout(5_000)), true);
      const review = store.get('owner', reviewId)!;
      const summaries = store.findRouterTasks('owner', 'project', '');
      assert.deepEqual(summaries.find(task => task.id === taskId)?.workerProtocols, ['codex-cli']);
      assert.equal(summaries.find(task => task.id === review.id)?.workflowId, workflow.id);
      assert.equal(review.result, 'Add a regression test.');
      assert.equal(review.status, 'waiting_review');
      assert.equal(store.command('owner', review.id, review.version, { action: 'accept_result' })?.status, 'succeeded');
    }
    assert.equal(store.command('owner', taskId, firstVersion, { action: 'append', text: live
      ? 'In the same checkout confirm notes.txt contains First change, then replace it with Second change followed by a newline and reply with exactly Resumed.'
      : 'Follow up' })?.status, 'queued');
    assert.equal(await client.runOnce(runSignal()), true);
    const final = store.get('owner', taskId)!;
    assert.match(final.result ?? '', /^Resumed\.?$/);
    const finalCheckpoint = checkpoint(String(firstCheckpoint?.session_id));
    assert(finalCheckpoint && finalCheckpoint.run_id !== firstCheckpoint?.run_id);
    if (isolated) {
      assert.equal(final.status, reviewer ? 'succeeded' : 'waiting_review');
      assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'Original\n');
      const artifacts = store.snapshot('owner').artifacts.filter(item => item.taskId === taskId);
      assert.equal(artifacts.length, 2);
      const readArtifact = async (id: string) => {
        const result = await fetch('http://127.0.0.1:' + address.port + '/v1/artifacts/' + id,
          { headers: { Authorization: 'Bearer local' } });
        assert.equal(result.status, 200);
        return result.text();
      };
      const patches = await Promise.all(artifacts.map(item => readArtifact(item.id)));
      assert(patches.some(body => body.includes('+First change')));
      assert(patches.some(body => body.includes('+Second change')));
      const last = store.timeline('owner', taskId)!.events.filter(event => event.type === 'run.finished').at(-1)!;
      const checkout = await inspectRunWorktree(root, join(state, 'run-worktrees'), String(last.data.runId));
      assert.equal(checkout.state, 'ready');
      assert.equal(firstCheckout?.state, 'ready');
      if (checkout.state === 'ready' && firstCheckout?.state === 'ready') assert.equal(checkout.root, firstCheckout.root);
      if (!reviewer) assert.equal(store.command('owner', taskId, final.version, { action: 'accept_result' })?.status, 'succeeded');
    }
    if (protocol === 'codex-cli' && !live) {
      const cancellation = store.createWorkflow('owner', 'cancel-codex-cli', 'project', [{
        key: 'edit', goal: 'Wait for cancellation', needs: [], workerProtocols: ['codex-cli'],
        workerCapability: 'writable-worktree',
      }]);
      const cancelTaskId = cancellation.steps[0].taskId;
      const signal = AbortSignal.timeout(5_000);
      const stopped = assert.rejects(client.runOnce(signal), /aborted/i);
      while (!store.timeline('owner', cancelTaskId)?.events.some(event => event.data.message === 'Codex session started')) {
        await delay(10, undefined, { signal });
      }
      const pid = Number(readFileSync(join(directory, 'cancel-pid'), 'utf8'));
      process.kill(pid, 0);
      const cancelled = await fetch('http://127.0.0.1:' + address.port + '/v1/tasks/' + cancelTaskId + '/commands', {
        method: 'POST', signal, headers: {
          Authorization: 'Bearer local', 'Content-Type': 'application/json', 'Idempotency-Key': 'cancel-codex-cli',
        },
        body: JSON.stringify({ action: 'cancel', expectedVersion: 1 }),
      });
      assert.equal(cancelled.status, 200);
      await stopped;
      assert.equal(store.get('owner', cancelTaskId)?.status, 'cancelled');
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
  });
}
