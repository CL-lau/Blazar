import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { createServer, connect } from 'node:http2';
import { once } from 'node:events';
import test from 'node:test';
import { ApnsProvider } from '../../packages/notifications/apns.ts';

test('APNs sends signed HTTP/2 requests with generic payloads and reuses authentication', async t => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  let sessionCount = 0;
  const token = 'aa'.repeat(32);
  const notification = randomUUID();
  const requests: { headers: Record<string, unknown>; body: string }[] = [];
  server.on('session', () => sessionCount++);
  server.on('stream', (stream, headers) => {
    stream.setEncoding('utf8');
    let body = '';
    stream.on('data', chunk => { body += chunk; });
    stream.on('end', () => {
      requests.push({ headers, body });
      const status = [200, 410, 429, 403, 200][requests.length - 1];
      stream.respond({ ':status': status });
      stream.end(status === 403 ? '{"reason":"ExpiredProviderToken"}' : '');
    });
  });
  let now = 1_700_000_000_000;
  const provider = new ApnsProvider({
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    teamId: 'AAAAAAAAAA', keyId: 'BBBBBBBBBB', sandbox: true, topic: 'com.blazar.app',
  }, origin => {
    assert.equal(origin, 'https://api.sandbox.push.apple.com');
    return connect('http://127.0.0.1:' + address.port);
  }, () => now);
  t.after(async () => {
    provider.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  assert.equal(await provider.send(token, notification, 'approval'), 'accepted');
  assert.equal(await provider.send(token, notification, 'task_update'), 'unregistered');
  assert.equal(await provider.send(token, notification, 'task_update'), 'retry');
  assert.equal(await provider.send(token, notification, 'task_update'), 'retry');
  now += 1000;
  assert.equal(await provider.send(token, notification, 'task_update'), 'accepted');
  assert.equal(sessionCount, 1);
  const first = requests[0];
  assert.equal(first.headers[':path'], '/3/device/' + token);
  assert.equal(first.headers['apns-topic'], 'com.blazar.app');
  assert.equal(first.headers['apns-id'], notification);
  assert.equal(first.headers['apns-push-type'], 'alert');
  assert.deepEqual(JSON.parse(first.body), { aps: { alert: { title: 'Blazar', body: 'A task needs your review.' } } });
  const authorization = String(first.headers.authorization);
  const [header, claims, signature] = authorization.slice('bearer '.length).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'ES256', kid: 'BBBBBBBBBB' });
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), { iss: 'AAAAAAAAAA', iat: 1_700_000_000 });
  assert(verify('sha256', Buffer.from(header + '.' + claims), { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url')));
  assert.equal(requests[3].headers.authorization, authorization);
  assert.notEqual(requests[4].headers.authorization, authorization);
});

test('push queue scopes notifications to paired owners and removes them on token rotation or revocation', async t => {
  const { TaskStore } = await import('./store.ts');
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const now = Date.now();
  const first = store.redeemPairing(store.createPairing('owner', now).code, 'Phone', now)!;
  const other = store.redeemPairing(store.createPairing('other', now).code, 'Other phone', now)!;
  const token = 'ab'.repeat(32);
  const otherToken = 'cd'.repeat(32);
  assert.equal(store.registerPush(first.token, token), true);
  assert.equal(store.registerPush(other.token, token), false);
  assert.equal(store.registerPush(other.token, otherToken), true);
  const task = store.create('owner', 'desktop', 'first', 'project', 'Review');
  const { run } = store.claim('owner', 'project', 'device', now, 45_000)!;
  store.requestApproval(run.id, 'device', 'Review the draft', now);
  const leasedAt = Date.now();
  const approval = store.leasePush(leasedAt)!;
  assert.equal(approval.kind, 'approval');
  assert.equal(approval.token, token);
  assert.equal(store.leasePush(leasedAt), undefined);
  store.finishPush(approval.id, 'retry', leasedAt);
  assert.equal(store.leasePush(leasedAt + 1), undefined);
  assert.equal(store.leasePush(leasedAt + 10_000)?.id, approval.id);
  assert.equal(store.registerPush(first.token, 'ef'.repeat(32)), true);
  store.finishPush(approval.id, 'unregistered', leasedAt);
  assert.equal(store.leasePush(leasedAt + 30_000), undefined);
  store.command('owner', task.id, 1, { action: 'cancel' });
  store.acknowledgeStop(run.id, 'device', now + 1);
  assert.equal(store.leasePush(Date.now())?.token, 'ef'.repeat(32));
  assert.equal(store.revokeMobile('owner', first.id), true);
  assert.equal(store.leasePush(leasedAt + 60_000), undefined);
});

test('dispatcher sends a pending approval via HTTP/2 and skips a decided approval', { timeout: 6000 }, async t => {
  const { TaskStore } = await import('./store.ts');
  const { startPushDelivery } = await import('./push.ts');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const provider = new ApnsProvider({
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    teamId: 'AAAAAAAAAA', keyId: 'BBBBBBBBBB', sandbox: true, topic: 'com.blazar.app',
  }, () => connect('http://127.0.0.1:' + address.port));
  const store = new TaskStore(':memory:');
  const now = Date.now();
  const pair = store.redeemPairing(store.createPairing('owner', now).code, 'Phone', now)!;
  const token = 'ab'.repeat(32);
  assert.equal(store.registerPush(pair.token, token), true);
  const old = store.create('owner', 'desktop', 'old', 'project', 'Old draft');
  const worker = { label: 'Isolated fixture', protocol: 'acp', capabilities: ['git-worktree' as const] };
  const oldRun = store.claim('owner', 'project', 'device', now, 45_000, '', '', undefined, worker)!;
  const decided = store.requestApproval(oldRun.run.id, 'device', 'Already reviewed', now)!;
  assert.ok(store.command('owner', old.id, 1, { action: 'approve', approvalId: String(decided.id) }));
  store.create('owner', 'desktop', 'new', 'project', 'Current draft');
  const newRun = store.claim('owner', 'project', 'another-device', now + 10, 45_000, '', '', undefined, worker)!;
  store.requestApproval(newRun.run.id, 'another-device', 'Private review details', now + 10);
  let count = 0;
  const arrived = Promise.withResolvers<string>();
  server.on('stream', (stream, headers) => {
    count++;
    assert.equal(headers[':path'], '/3/device/' + token);
    const chunks: Buffer[] = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      stream.respond({ ':status': 200 });
      stream.end();
      arrived.resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
  const stop = startPushDelivery(store, provider);
  t.after(async () => {
    await stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const payload = await arrived.promise;
  assert.doesNotMatch(payload, /private|draft|review details/i);
  assert.match(payload, /A task needs your review/);
  const { setTimeout: delay } = await import('node:timers/promises');
  await delay(1100);
  assert.equal(count, 1);
  assert.equal(store.leasePush(Date.now() + 30_000), undefined);
});
