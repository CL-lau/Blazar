import { createFeishuSender, feishuChannel } from '../../packages/channels/feishu.ts';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { routerServer } from './http.ts';
import { TaskStore } from './store.ts';

test('Feishu callbacks verify the source and link authorized thread replies', async t => {
  const store = new TaskStore(':memory:');
  const feishu = {
    token: 'verification', appId: 'app', tenant: 'tenant', workspace: 'workspace',
    senders: new Set(['person']), chats: new Set(['chat']),
  };
  const server = routerServer(store, { owner: 'owner', token: 'admin', feishu });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
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
  const follow = makeEvent('follow', '/blazar Include recommendations', { root: 'root' });
  assert.equal((await post(follow)).status, 200);
  assert.equal((await post(follow)).status, 200);
  assert.equal(store.get('owner', tasks[0].id)?.version, 2);
  assert.equal(store.timeline('owner', tasks[0].id)?.events[0].data.text, 'Include recommendations');
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
  const current = store.claim('owner', 'workspace', 'device', Date.now(), 45_000)!;
  const cancel = makeEvent('cancel', '/blazar /cancel', { root: 'pausable-root' });
  await post(cancel);
  await post(cancel);
  assert.equal(store.get('owner', queued.id)?.status, 'cancelling');
  assert.deepEqual(store.deviceStopTargets('device').map(row => row.id), [current.run.id]);
  assert.equal(store.get('owner', queued.id)?.version, 2);
  assert.equal(store.acknowledgeStop(current.run.id, 'device', Date.now()), true);
  assert.equal(store.get('owner', queued.id)?.status, 'cancelled');

});
