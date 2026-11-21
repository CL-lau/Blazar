import { createFeishuSender, feishuChannel } from '../../packages/channels/feishu.ts';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DeviceSocket } from '../device/socket.ts';
import { routerServer } from './http.ts';
import { TaskStore } from './store.ts';

test('Feishu callbacks verify the source and link authorized thread replies', async t => {
  const store = new TaskStore(':memory:');
  const feishu = {
    token: 'verification', appId: 'app', tenant: 'tenant', workspace: 'workspace',
    senders: new Set(['person']), chats: new Set(['chat']),
  };
  const downloads: string[] = [];
  const adapter = createFeishuSender('app', 'secret', 'lark', async (input, init) => {
    const url = String(input);
    if (url.endsWith('/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 3600 });
    }
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture');
    assert.equal(init?.redirect, 'error');
    downloads.push(url);
    if (url.includes('/oversized/')) return new Response('x'.repeat(8193));
    return new Response('Approved fixture document');
  });
  const server = routerServer(store, { owner: 'owner', token: 'admin', feishu, readFeishuAttachment: adapter.readAttachment });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeDeviceSockets();
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    store.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const post = (data: object) => fetch('http://127.0.0.1:' + address.port + '/v1/channels/feishu/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const makeEvent = (id: string, text: string, { root = '', sender = 'person', chat = 'chat', token = feishu.token } = {}) => ({
    schema: '2.0',
    header: { token, app_id: 'app', tenant_key: 'tenant', event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: sender }, sender_type: 'user' },
      message: { message_id: id, root_id: root, chat_id: chat, message_type: 'text', content: JSON.stringify({ text }) },
    },
  });

  const challenge = await post({ type: 'url_verification', token: feishu.token, challenge: 'proof' });
  assert.deepEqual(await challenge.json(), { challenge: 'proof' });
  assert.equal((await post(makeEvent('wrong-token', '/blazar Read notes', { token: 'wrong' }))).status, 401);
  assert.equal((await post(makeEvent('wrong-sender', '/blazar Read notes', { sender: 'unlisted' }))).status, 200);
  assert.equal((await post(makeEvent('untriggered', 'Read notes'))).status, 200);
  assert.deepEqual(store.snapshot('owner').tasks, []);
  const root = makeEvent('root', '/blazar /preview notes.md');
  assert.equal((await post(root)).status, 200);
  assert.equal((await post(root)).status, 200);
  const tasks = store.snapshot('owner').tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].goal, '/preview notes.md');
  assert.equal((await post(makeEvent('other-chat', '/blazar Ignore this', { root: 'root', chat: 'unlisted' }))).status, 200);
  const device = store.registerDevice('owner', 'Feishu fixture', 'workspace');
  const socket = new DeviceSocket(new URL('http://127.0.0.1:' + address.port), device.token);
  t.after(() => socket.close());
  const signal = AbortSignal.timeout(4_000);
  const claimed = await socket.request('claim', { capability: 'document.preview', requestId: randomUUID() }, signal);
  const { assignment } = await claimed.json();
  const stop = Promise.withResolvers<void>();
  const unwatch = socket.onStop(assignment.run.id, stop.resolve);
  const follow = makeEvent('follow', '/blazar Include recommendations', { root: 'root' });
  assert.equal((await post(follow)).status, 200);
  await Promise.race([stop.promise, once(signal, 'abort').then(() => signal.throwIfAborted())]);
  unwatch();
  const stopped = await socket.request('runs/' + assignment.run.id + '/stopped', {}, signal);
  assert.equal(stopped.status, 200);
  assert.equal((await post(follow)).status, 200);
  assert.equal(store.get('owner', tasks[0].id)?.version, 2);
  assert.equal(store.timeline('owner', tasks[0].id)?.events.find(event => event.type === 'task.instruction_added')?.data.text, 'Include recommendations');
  const run = store.claim('owner', 'workspace', 'device', Date.now(), 45_000)!;
  const outcome = { status: 'succeeded' as const, result: 'Private workspace output' };
  assert.equal(store.finish(run.run.id, 'device', Date.now(), outcome), true);
  assert.equal(store.finish(run.run.id, 'device', Date.now(), outcome), true);
  const now = Date.now();
  const first = store.leaseChannelNotice(feishuChannel(feishu), now)!;
  assert.equal(first.messageId, 'root');
  assert.doesNotMatch(first.text, /Private workspace output/);
  assert.equal(store.leaseChannelNotice(feishuChannel(feishu), now + 1), undefined);
  const retry = store.leaseChannelNotice(feishuChannel(feishu), now + 30_000)!;
  assert.equal(retry.id, first.id);
  const requests: [string, RequestInit | undefined][] = [];
  const sender = createFeishuSender('app', 'secret', 'lark', async (input, init) => {
    requests.push([String(input), init]);
    return Response.json(requests.length === 1 ? { code: 0, tenant_access_token: 'access', expire: 3600 } : { code: 0 });
  });
  await sender(retry.messageId, retry.text, retry.id);
  assert.equal(requests[1][0], 'https://open.larksuite.com/open-apis/im/v1/messages/root/reply');
  const sent = JSON.parse(String(requests[1][1]?.body));
  assert.equal(sent.uuid, first.id);
  assert.equal(sent.reply_in_thread, true);
  store.finishChannelNotice(first.id, true);
  assert.equal(store.leaseChannelNotice(feishuChannel(feishu), now + 60_000), undefined);

  await post(makeEvent('cancel-without-thread', '/blazar /cancel'));
  assert.equal(store.snapshot('owner').tasks.length, 1);
  await post(makeEvent('pausable-root', '/blazar /preview draft.md'));
  const queued = store.snapshot('owner').tasks.find(item => item.goal === '/preview draft.md')!;
  await post(makeEvent('unauthorized-cancel', '/blazar /cancel', { root: 'pausable-root', sender: 'unlisted' }));
  await post(makeEvent('wrong-thread-cancel', '/blazar /cancel', { root: 'unknown' }));
  assert.equal(store.get('owner', queued.id)?.status, 'queued');
  const firstRun = store.claim('owner', 'workspace', 'device', Date.now(), 45_000)!;
  const pause = makeEvent('pause', '/blazar /暂停', { root: 'pausable-root' });
  await post(pause);
  await post(pause);
  assert.equal(store.get('owner', queued.id)?.status, 'pausing');
  assert.equal(store.get('owner', queued.id)?.version, 2);
  assert.deepEqual(store.deviceStopTargets('device').map(row => row.id), [firstRun.run.id]);
  await post(makeEvent('early-resume', '/blazar /resume', { root: 'pausable-root' }));
  assert.equal(store.get('owner', queued.id)?.status, 'pausing');
  assert.equal(store.acknowledgeStop(firstRun.run.id, 'device', Date.now()), true);
  await post(makeEvent('resume', '/blazar /继续', { root: 'pausable-root' }));
  assert.equal(store.get('owner', queued.id)?.status, 'queued');
  assert.equal(store.get('owner', queued.id)?.version, 3);
  const current = store.claim('owner', 'workspace', 'device', Date.now(), 45_000)!;
  const cancel = makeEvent('cancel', '/blazar /cancel', { root: 'pausable-root' });
  await post(cancel);
  await post(cancel);
  assert.equal(store.get('owner', queued.id)?.status, 'cancelling');
  assert.deepEqual(store.deviceStopTargets('device').map(row => row.id), [current.run.id]);
  assert.equal(store.get('owner', queued.id)?.version, 4);
  assert.equal(store.acknowledgeStop(current.run.id, 'device', Date.now()), true);
  assert.equal(store.get('owner', queued.id)?.status, 'cancelled');

  await post(makeEvent('file-root', '/blazar Summarize attached notes'));
  const target = store.snapshot('owner').tasks.find(item => item.goal === 'Summarize attached notes')!;
  const fileEvent = (id: string, sender = 'person', thread = 'file-root') => {
    const message = makeEvent(id, '', { root: thread, sender });
    message.event.message.message_type = 'file';
    message.event.message.content = JSON.stringify({ file_key: 'file_v2_fixture', file_name: 'notes.txt' });
    return message;
  };
  await post(fileEvent('unauthorized-file', 'unlisted'));
  await post(fileEvent('unlinked-file', 'person', 'unknown-thread'));
  assert.deepEqual(downloads, []);
  await post(fileEvent('oversized'));
  assert.equal(store.get('owner', target.id)?.version, 1);

  const oldAssignment = await (await socket.request('claim', { capability: 'agent.acp' }, signal)).json();
  const oldRun = oldAssignment.assignment.run.id;
  assert.equal(oldAssignment.assignment.task.id, target.id);
  assert.equal((await socket.request('runs/' + oldRun + '/steer', {}, signal)).status, 200);
  const attachmentStop = Promise.withResolvers<void>();
  const unsubscribe = socket.onStop(oldRun, attachmentStop.resolve);
  assert.equal((await post(fileEvent('notes-file'))).status, 200);
  await Promise.race([attachmentStop.promise, once(signal, 'abort').then(() => signal.throwIfAborted())]);
  unsubscribe();
  assert.equal((await socket.request('runs/' + oldRun + '/stopped', {}, signal)).status, 200);
  await post(fileEvent('notes-file'));
  assert.equal(downloads.length, 2);
  assert.equal(downloads[1], 'https://open.larksuite.com/open-apis/im/v1/messages/notes-file/resources/file_v2_fixture?type=file');
  const nextAssignment = await (await socket.request('claim', { capability: 'agent.acp' }, signal)).json();
  assert.deepEqual(nextAssignment.assignment.attachments, [{ name: 'notes.txt', text: 'Approved fixture document' }]);
  assert.equal(nextAssignment.assignment.task.version, 2);
  assert.doesNotMatch(JSON.stringify(store.timeline('owner', target.id)), /Approved fixture document/);

});

test('Feishu and Lark isolate callback identity and outbound notices in one Router', async t => {
  const store = new TaskStore(':memory:');
  const common = { appId: 'app', tenant: 'tenant', senders: new Set(['person']), chats: new Set(['chat']) };
  const feishu = { ...common, token: 'feishu-verification', workspace: 'cn' };
  const lark = { ...common, token: 'lark-verification', workspace: 'global' };
  const server = routerServer(store, { owner: 'owner', token: 'admin', feishu, lark });
  server.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const callback = (region: string, token: string) => fetch(
    'http://127.0.0.1:' + address.port + '/v1/channels/' + region + '/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Blazar-Public-Gateway': '1' },
      body: JSON.stringify({
        schema: '2.0', header: { token, app_id: common.appId, tenant_key: common.tenant, event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_type: 'user', sender_id: { open_id: 'person' } },
          message: { message_id: 'shared-id', chat_id: 'chat', message_type: 'text',
            content: JSON.stringify({ text: '/blazar Review notes' }) },
        },
      }),
    },
  );
  assert.equal((await callback('feishu', lark.token)).status, 401);
  assert.equal((await callback('lark', feishu.token)).status, 401);
  for (const [region, config] of [['feishu', feishu], ['lark', lark]] as const) {
    assert.equal((await callback(region, config.token)).status, 200);
    assert.equal((await callback(region, config.token)).status, 200);
    const now = Date.now();
    const { run } = store.claim('owner', config.workspace, region, now, 45_000)!;
    assert.equal(store.finish(run.id, region, now, { status: 'succeeded', result: 'Private fixture' }), true);
    const notice = store.leaseChannelNotice(feishuChannel(config, region), now + 10);
    assert.ok(notice);
    assert.equal(notice.messageId, 'shared-id');
    assert.doesNotMatch(notice.text, /Private fixture/);
    const host = region === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
    const requests: string[] = [];
    const sender = createFeishuSender(config.appId, region + '-secret', region, async (input, options) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, host);
      requests.push(url.pathname);
      const payload = JSON.parse(String(options?.body));
      if (url.pathname.endsWith('/internal')) {
        assert.equal(payload.app_secret, region + '-secret');
        return Response.json({ code: 0, tenant_access_token: region + '-access', expire: 7200 });
      }
      assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer ' + region + '-access');
      assert.equal(payload.uuid, notice.id);
      assert.equal(JSON.parse(payload.content).text, notice.text);
      return Response.json({ code: 0 });
    });
    await sender(notice.messageId, notice.text, notice.id);
    assert.deepEqual(requests, ['/open-apis/auth/v3/tenant_access_token/internal', '/open-apis/im/v1/messages/shared-id/reply']);
    store.finishChannelNotice(notice.id, true);
  }
  assert.equal(store.snapshot('owner').tasks.length, 2);
  assert.deepEqual(store.metrics('owner', Date.now()).channelDelivery.map(row => [row.channel, row.sent]),
    [['feishu', 1], ['lark', 1]]);
});
