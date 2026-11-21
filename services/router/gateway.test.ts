import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { routerServer } from './http.ts';
import { TaskStore } from './store.ts';

test('the public gateway carries a paired phone screenshot task and WSS Worker result end to end', {
  skip: !process.env.BLAZAR_TEST_CADDY_EXECUTABLE && 'Set BLAZAR_TEST_CADDY_EXECUTABLE to a Caddy executable',
  timeout: 15_000,
}, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'blazar-gateway-test-')));
  let stopGateway: (() => Promise<void>) | undefined;
  t.after(async () => {
    await stopGateway?.();
    await rm(directory, { force: true, recursive: true });
  });
  const store = new TaskStore(':memory:');
  const router = routerServer(store, { owner: 'owner', token: 'local-admin' });
  router.listen(0, '127.0.0.1');
  await once(router, 'listening');
  t.after(async () => {
    await new Promise<void>(resolve => router.close(() => resolve()));
    store.close();
  });
  const upstream = router.address();
  assert(upstream && typeof upstream !== 'string');
  const temporary = createServer();
  temporary.listen(0, '127.0.0.1');
  await once(temporary, 'listening');
  const publicAddress = temporary.address();
  assert(publicAddress && typeof publicAddress !== 'string');
  await new Promise<void>(resolve => temporary.close(() => resolve()));
  const base = 'https://127.0.0.1:' + publicAddress.port;

  const caddyfile = join(directory, 'Caddyfile');
  const production = await readFile(new URL('../../deploy/Caddyfile', import.meta.url), 'utf8');
  await writeFile(caddyfile, '{\n admin off\n auto_https disable_redirects\n skip_install_trust\n}\n' +
    production.replace('{$BLAZAR_PUBLIC_HOST} {', '{$BLAZAR_PUBLIC_HOST} {\n tls internal'));
  const gateway = spawn(process.env.BLAZAR_TEST_CADDY_EXECUTABLE!, ['run', '--config', caddyfile, '--adapter', 'caddyfile'], {
    env: { ...process.env, XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory,
      BLAZAR_PUBLIC_HOST: base, BLAZAR_PORT: String(upstream.port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const closed = once(gateway, 'close');
  let diagnostics = '';
  gateway.stderr.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-4000); });
  stopGateway = async () => {
    gateway.kill();
    await closed;
  };
  const caFile = join(directory, 'caddy', 'pki', 'authorities', 'local', 'root.crt');
  const limit = AbortSignal.timeout(5_000);

  function send(path: string, ca: Buffer, token?: string, body?: object) {
    return new Promise<{ status?: number; type?: string; cache?: string; body: Buffer }>((resolve, reject) => {
      const req = request(base + path, {
        ca, signal: AbortSignal.timeout(2_000), method: body ? 'POST' : 'GET',
        headers: {
          ...(token && { Authorization: 'Bearer ' + token }),
          ...(body && { 'Content-Type': 'application/json', 'Idempotency-Key': 'gateway-visual' }),
        },
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => resolve({ status: response.statusCode,
          type: response.headers['content-type'], cache: response.headers['cache-control'], body: Buffer.concat(chunks) }));
      });
      req.once('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }

  let ca: Buffer;
  for (;;) {
    if (gateway.exitCode !== null || limit.aborted) throw new Error('Caddy did not start: ' + diagnostics);
    try {
      ca = await readFile(caFile);
      assert.equal((await send('/v1/health', ca)).status, 404);
      break;
    } catch {
      await delay(50);
    }
  }

  const now = Date.now();
  const phone = store.redeemPairing(store.createPairing('owner', now).code, 'Paired phone', now)!;
  const otherPhone = store.redeemPairing(store.createPairing('other', now).code, 'Other phone', now)!;
  const device = store.registerDevice('owner', 'Computer', 'project');
  const socket = new WebSocket(base.replace(/^https:/, 'wss:') + '/v1/devices/connect', {
    ca, handshakeTimeout: 3_000, headers: { Authorization: 'Bearer ' + device.token },
  });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  let messageId = 0;
  async function deviceRequest(path: string, body: object) {
    const id = ++messageId;
    const message = once(socket, 'message', { signal: AbortSignal.timeout(3_000) });
    socket.send(JSON.stringify({ id, path, body }));
    const [raw] = await message;
    const response = JSON.parse(raw.toString());
    assert.equal(response.id, id);
    return response;
  }
  const claim = () => deviceRequest('claim', {
    requestId: randomUUID(), capability: 'computer.observe', desktopApps: ['notes'],
    desktopControls: [{ alias: 'notes', visual: true, buttons: [] }],
    desktopPermissions: { accessibility: 'granted', screen_recording: 'granted', automation: 'unknown' },
  });
  const available = await claim();
  assert.equal(available.status, 200);
  assert.equal(available.body.assignment, null);

  const goal = '/observe notes --window w-1 --instance ' + 'a'.repeat(64) + ' --visual';
  const submitted = await send('/v1/events', ca, phone.token, { workspace: 'project', text: goal, desktopDevice: device.id });
  assert.equal(submitted.status, 202);
  const task = JSON.parse(submitted.body.toString());
  const assigned = await claim();
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.assignment.task.id, task.id);
  assert.equal(assigned.body.assignment.task.goal, goal);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS4sAAAAASUVORK5CYII=', 'base64');
  const finished = await deviceRequest('runs/' + assigned.body.assignment.run.id + '/finish', {
    status: 'succeeded', result: 'Screenshot captured',
    artifact: { name: 'window.png', mime: 'image/png', text: png.toString('base64') },
  });
  assert.equal(finished.status, 200);
  const artifact = store.snapshot('owner').artifacts.find(item => item.taskId === task.id)!;
  const path = '/v1/artifacts/' + artifact.id;
  assert.equal((await send(path, ca)).status, 401);
  assert.equal((await send(path, ca, 'local-admin')).status, 401);
  assert.equal((await send(path, ca, otherPhone.token)).status, 404);
  const image = await send(path, ca, phone.token);
  assert.equal(image.status, 200);
  assert.equal(image.type, 'image/png');
  assert.equal(image.cache, 'no-store');
  assert.deepEqual(image.body, png);
  assert(store.revokeMobile('owner', phone.id));
  assert.equal((await send(path, ca, phone.token)).status, 401);
});
