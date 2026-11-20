import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { DeviceSocket } from '../device/socket.ts';
import { routerServer } from './http.ts';
import { TaskStore } from './store.ts';

test('device WebSocket reconnects under the existing lease and enforces revocation', async t => {
  const store = new TaskStore(':memory:');
  const server = routerServer(store, { owner: 'owner', token: 'admin' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = new URL('http://127.0.0.1:' + address.port);
  const device = store.registerDevice('owner', 'Computer', 'work');
  const connection = new DeviceSocket(url, device.token);
  const invalid = new DeviceSocket(url, 'admin');
  t.after(async () => {
    connection.close();
    invalid.close();
    server.closeDeviceSockets();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const signal = AbortSignal.timeout(5_000);
  await assert.rejects(invalid.request('claim', {}, signal));
  const task = store.create('owner', 'test', 'request', 'work', '/preview notes.md');
  const second = store.create('owner', 'test', 'second-request', 'work', '/preview later.md');
  const claim = { capability: 'document.preview', requestId: randomUUID() };
  const claimed = await connection.request('claim', claim, signal);
  const { assignment } = await claimed.json();
  assert.equal(assignment.task.id, task.id);
  connection.close();
  const repeated = await connection.request('claim', claim, signal);
  assert.equal((await repeated.json()).assignment.run.id, assignment.run.id);
  assert.equal(store.get('owner', second.id)?.status, 'queued');
  const conflict = await connection.request('claim', { ...claim, capability: 'agent.acp' }, signal);
  assert.equal(conflict.status, 409);
  const renew = await connection.request('runs/' + assignment.run.id + '/renew', {}, signal);
  assert.equal(renew.status, 200);
  connection.close();
  const updated = store.command('owner', task.id, 1, { action: 'append', text: 'Use the latest notes' });
  assert.equal(updated?.version, 2);
  const staleRenewal = await connection.request('runs/' + assignment.run.id + '/renew', {}, signal);
  assert.equal(staleRenewal.status, 409);
  let replayed = false;
  const unwatch = connection.onStop(assignment.run.id, () => { replayed = true; });
  assert.equal(replayed, true);
  unwatch();
  assert.equal(store.revokeDevice('owner', device.id), true);
  const denied = await connection.request('runs/' + assignment.run.id + '/renew', {}, signal);
  assert.equal(denied.status, 401);
});

test('lease renewal recovers after a TCP partition drops the device WebSocket', { timeout: 5000 }, async t => {
  const { createServer, connect } = await import('node:net');
  const { performance } = await import('node:perf_hooks');
  const { maintainLease } = await import('../device/lease.ts');
  const store = new TaskStore(':memory:');
  const router = routerServer(store, { owner: 'owner', token: 'admin' });
  router.listen(0, '127.0.0.1');
  await once(router, 'listening');
  const routerAddress = router.address();
  assert(routerAddress && typeof routerAddress !== 'string');

  let partitioned = false;
  const clients = new Set<import('node:net').Socket>();
  const gateway = createServer(client => {
    clients.add(client);
    client.once('close', () => clients.delete(client));
    client.on('error', () => client.destroy());
    if (partitioned) {
      client.destroy();
      return;
    }
    const upstream = connect(routerAddress.port, '127.0.0.1');
    upstream.on('error', () => client.destroy());
    upstream.once('close', () => client.destroy());
    client.once('close', () => upstream.destroy());
    client.pipe(upstream).pipe(client);
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const address = gateway.address();
  assert(address && typeof address !== 'string');
  const device = store.registerDevice('owner', 'Computer', 'work');
  const connection = new DeviceSocket(new URL('http://127.0.0.1:' + address.port), device.token);
  const stop = new AbortController();
  t.after(async () => {
    stop.abort();
    connection.close();
    for (const client of clients) client.destroy();
    router.closeDeviceSockets();
    await Promise.all([gateway, router].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    store.close();
  });

  const task = store.create('owner', 'test', 'intent', 'work', '/preview notes.md');
  const claimed = await connection.request('claim', { capability: 'document.preview' }, stop.signal);
  const { assignment, leaseRemainingMs } = await claimed.json();
  assert.equal(assignment.task.id, task.id);
  const runPath = 'runs/' + assignment.run.id + '/';
  partitioned = true;
  for (const client of clients) client.destroy();
  let failedAttempts = 0;
  let recovered = false;
  await maintainLease(performance.now() + leaseRemainingMs, async signal => {
    try {
      const response = await connection.request(runPath + 'renew', {}, signal);
      assert.equal(response.status, 200);
      const extension = (await response.json()).leaseRemainingMs;
      recovered = true;
      const finished = await connection.request(runPath + 'finish', { status: 'succeeded', result: 'Recovered' }, signal);
      assert.equal(finished.status, 200);
      stop.abort();
      return extension;
    } catch (error) {
      if (!partitioned) throw error;
      failedAttempts++;
      partitioned = false;
      throw error;
    }
  }, stop, stop.signal, 20, 10);
  assert.equal(failedAttempts, 1);
  assert.equal(recovered, true);
  assert.equal(store.get('owner', task.id)?.result, 'Recovered');
});
