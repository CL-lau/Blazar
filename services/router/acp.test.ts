import { realpathSync } from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorker, workerCatalog } from '../../packages/workers/registry.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { probeAcp, runAcp } from '../../packages/workers/acp.ts';

const fixture = String.raw`
const { createInterface } = require('node:readline');
const send = value => console.log(JSON.stringify({ jsonrpc: '2.0', ...value }));
createInterface({ input: process.stdin }).on('line', line => {
  const { method, id, params } = JSON.parse(line);
  if (method === 'initialize') send({ id, result: { protocolVersion: 1 } });
  if (method === 'session/new') send({ id, result: { sessionId: 'session' } });
  if (method === 'session/prompt') {
    const input = JSON.parse(params.prompt[0].text);
    if (input.goal === 'wait') return;
    for (const status of ['in_progress', 'in_progress', 'completed']) {
      send({ method: 'session/update', params: { sessionId: 'session', update: {
        sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Private workspace path', kind: 'read', status,
      } } });
    }
    send({ method: 'session/update', params: {
      sessionId: 'session',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: input.goal + ': ' + input.instructions[0] } },
    } });
    send({ id, result: { stopReason: 'end_turn' } });
  }
});
`;
const worker = { executable: process.execPath, args: ['-e', fixture], label: 'Test Agent' };

test('ACP probe reports a successful handshake without opening a session', async () => {
  const onlyInitialize = { ...worker, args: ['-e', `
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const { method, id } = JSON.parse(line);
      if (method !== 'initialize') process.exit(3);
      console.log(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } }));
    });
  `] };
  assert.deepEqual(await probeAcp(onlyInitialize, process.cwd(), AbortSignal.timeout(2000)),
    { version: 1, loadSession: false, resumeSession: false });
});

test('ACP starts a subprocess, initializes a session, and assembles streamed text', async () => {
  const progress: string[] = [];
  const result = await runAcp(worker, process.cwd(), {
    goal: 'Review notes', instructions: ['Three bullets'], predecessors: [],
  }, AbortSignal.timeout(2_000), undefined, async message => { progress.push(message); });
  assert.equal(result, 'Review notes: Three bullets');
  assert.deepEqual(progress, ['Worker is using a tool', 'Worker completed a tool call']);
});

test('ACP allows a successful Worker to checkpoint on stdin EOF', async t => {
  const root = mkdtempSync(join(tmpdir(), 'blazar-acp-checkpoint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkpointing = { ...worker, args: ['-e', fixture.replace(
    "createInterface({ input: process.stdin }).on('line'", `createInterface({ input: process.stdin })
      .on('close', () => setTimeout(() => require('node:fs').writeFileSync('checkpoint', 'saved'), 75))
      .on('line'`)] };
  assert.equal(await runAcp(checkpointing, root, {
    goal: 'Review notes', instructions: ['Three bullets'], predecessors: [],
  }, AbortSignal.timeout(3_000)), 'Review notes: Three bullets');
  assert.equal(readFileSync(join(root, 'checkpoint'), 'utf8'), 'saved');
});

test('ACP sends native cancellation to a worker that has an active prompt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'blazar-acp-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(3_000)]);
  const cancellable = { ...worker, args: ['-e', fixture
    .replace("if (input.goal === 'wait') return;", "if (input.goal === 'wait') return require('node:fs').writeFileSync('ready', '');")
    .replace("if (method === 'session/prompt')", `if (method === 'session/cancel') {
      require('node:fs').writeFileSync('cancelled', params.sessionId);
      process.exit(0);
    }
    if (method === 'session/prompt')`)] };
  const done = assert.rejects(runAcp(cancellable, root, {
    goal: 'wait', instructions: [], predecessors: [],
  }, signal));
  while (!existsSync(join(root, 'ready'))) await delay(10, undefined, { signal });
  stop.abort();
  await done;
  assert.equal(readFileSync(join(root, 'cancelled'), 'utf8'), 'session');
});

test('a local ACP manifest launches through the same adapter and cannot opt into Router credentials', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'blazar-worker-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'worker.json');
  const manifest = { ...worker, version: 1, protocol: 'acp' };
  writeFileSync(path, JSON.stringify(manifest));
  const configured = await resolveWorker('custom', path);
  assert.ok(configured);
  const output = await runAcp(configured, directory, {
    goal: 'Draft a checklist', instructions: ['Use concise tasks'], predecessors: [],
  }, AbortSignal.timeout(2_000));
  assert.equal(output, 'Draft a checklist: Use concise tasks');
  writeFileSync(path, JSON.stringify({ ...manifest, env: ['BLAZAR_ROUTER_TOKEN'] }));
  await assert.rejects(resolveWorker('custom', path), /environment list/);
});

test('built-in ACP presets retain their protocol arguments with an explicit executable path', async () => {
  const expected = {
    deepseek: ['--profile', 'acp'],
    omp: ['acp'],
    opencode: ['acp'],
    copilot: ['--acp', '--stdio'],
    droid: ['exec', '--output-format', 'acp-daemon'],
    qwen: ['--acp'],
    kimi: ['acp'],
    kiro: ['acp', '--agent-engine=v3'],
    auggie: ['--acp'],
    gemini: ['--acp'],
    cursor: ['acp'],
    antigravity: [],
    cline: ['--acp'],
    goose: ['acp'],
    amp: [],
  };
  for (const [mode, args] of Object.entries(expected)) {
    const configured = await resolveWorker(mode, undefined, process.execPath);
    assert.equal(configured?.executable, process.execPath);
    assert.deepEqual(configured.args, args);
  }
  await assert.rejects(resolveWorker('droid', undefined, './agent'), /must be absolute/);
});

test('every built-in ACP worker runs the same local subprocess contract', {
  skip: process.platform === 'win32' ? 'The mock executable uses a Unix shebang' : false,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'blazar-built-in-acp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'mock-acp.cjs');
  writeFileSync(executable, '#!/usr/bin/env node\n' + fixture
    .replace("if (input.goal === 'wait') return;", `
      if (input.goal === 'wait') {
        require('node:fs').writeFileSync('ready', '');
        return;
      }
      if (input.goal === 'fail') {
        send({ id, result: { stopReason: 'refusal' } });
        return;
      }`)
    .replace("if (method === 'session/prompt')", `
      if (method === 'session/cancel') {
        require('node:fs').writeFileSync('cancelled', params.sessionId);
        process.exit(0);
      }
      if (method === 'session/prompt')`), { mode: 0o700 });

  for (const entry of workerCatalog().filter(entry => entry.protocol === 'acp')) {
    await t.test(entry.label, async () => {
      const cwd = mkdtempSync(join(root, entry.id + '-'));
      const configured = await resolveWorker(entry.id, undefined, executable);
      assert.ok(configured && configured.label === entry.label);
      const signal = AbortSignal.timeout(5_000);
      assert.deepEqual(await probeAcp(configured, cwd, signal),
        { version: 1, loadSession: false, resumeSession: false });
      const progress: string[] = [];
      const input = { goal: 'Review notes', instructions: ['Three bullets'], predecessors: [] };
      assert.equal(await runAcp(configured, cwd, input, signal, undefined, async message => { progress.push(message); }),
        'Review notes: Three bullets');
      assert.deepEqual(progress, ['Worker is using a tool', 'Worker completed a tool call']);
      await assert.rejects(runAcp(configured, cwd, { ...input, goal: 'fail' }, signal), /completed response/);

      const stop = new AbortController();
      const cancelled = assert.rejects(runAcp(configured, cwd, { ...input, goal: 'wait' },
        AbortSignal.any([signal, stop.signal])), /aborted/i);
      while (!existsSync(join(cwd, 'ready'))) await delay(10, undefined, { signal });
      stop.abort();
      await cancelled;
      assert.equal(readFileSync(join(cwd, 'cancelled'), 'utf8'), 'session');
    });
  }
});

test('ACP forwards only one-time approval for files inside the workspace', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'blazar-acp-approval-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, 'notes.txt');
  writeFileSync(target, 'Sample notes');
  const permissionWorker = {
    executable: process.execPath, label: 'Test Agent',
    args: ['-e', String.raw`
      const { createInterface } = require('node:readline');
      const target = process.argv[1];
      let prompt;
      const send = value => console.log(JSON.stringify({ jsonrpc: '2.0', ...value }));
      createInterface({ input: process.stdin }).on('line', line => {
        const { method, id, params, result } = JSON.parse(line);
        if (method === 'initialize') send({ id, result: { protocolVersion: 1 } });
        if (method === 'session/new') send({ id, result: { sessionId: 'session' } });
        if (method === 'session/prompt') {
          prompt = id;
          send({ id: 'permission', method: 'session/request_permission', params: {
            sessionId: 'session', toolCall: { toolCallId: 'read', kind: 'read', locations: [{ path: target }] },
            options: [{ optionId: 'always', name: 'Always', kind: 'allow_always' },
                      { optionId: 'once', name: 'Once', kind: 'allow_once' }],
          } });
        }
        if (id === 'permission') {
          send({ method: 'session/update', params: { sessionId: 'session', update: {
            sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: result.outcome.optionId || result.outcome.outcome },
          } } });
          send({ id: prompt, result: { stopReason: 'end_turn' } });
        }
      });
    `, target],
  };
  const job = { goal: 'Read notes', instructions: [], predecessors: [] };
  assert.equal(await runAcp(permissionWorker, directory, job, AbortSignal.timeout(2_000), async summary => {
    assert.match(summary, /"notes\.txt"/);
    return 'approved';
  }), 'once');
  assert.equal(await runAcp(permissionWorker, directory, job, AbortSignal.timeout(2_000)), 'cancelled');
  const outside = { ...permissionWorker, args: [...permissionWorker.args.slice(0, -1), process.execPath] };
  assert.equal(await runAcp(outside, directory, job, AbortSignal.timeout(2_000), async () => {
    throw new Error('Out-of-workspace requests should be cancelled automatically');
  }), 'cancelled');
});
