import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { parseWeixin, type WeixinConfig } from '../../packages/channels/weixin.ts';
import { feishuChannel } from '../../packages/channels/feishu.ts';
import { DeviceSocket } from '../device/socket.ts';
import { routerServer } from './http.ts';
import { TaskStore } from './store.ts';

test('WeChat intake, paired-phone approval, desktop artifact and Feishu follow-up share one task', async t => {
  const store = new TaskStore(':memory:');
  const owner = 'owner';
  const workspace = 'project';
  const wechat: WeixinConfig = {
    botId: 'wechat-bot', token: 'fixture', base: 'https://ilinkai.weixin.qq.com', workspace,
    senders: new Set(['wechat-user']),
  };
  const feishu = {
    token: 'fixture-feishu', appId: 'app', tenant: 'tenant', workspace,
    senders: new Set(['feishu-user']), chats: new Set(['feishu-chat']),
  };
  const server = routerServer(store, { owner, token: 'admin-fixture', feishu });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = new URL('http://127.0.0.1:' + address.port);
  const signal = AbortSignal.timeout(5000);
  const device = store.registerDevice(owner, 'Execution fixture', workspace);
  const socket = new DeviceSocket(base, device.token);
  t.after(async () => {
    socket.close();
    server.closeDeviceSockets();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });

  const post = (path: string, body: Record<string, unknown>, bearer?: string, key?: string) =>
    fetch(new URL(path, base), {
      method: 'POST', signal,
      headers: {
        'Content-Type': 'application/json',
        ...(bearer && { Authorization: 'Bearer ' + bearer }),
        ...(key && { 'Idempotency-Key': key }),
      },
      body: JSON.stringify(body),
    });
  const admin = 'admin-fixture';
  const snapshot = async (token: string) => {
    const response = await fetch(new URL('/v1/state', base), { headers: { Authorization: 'Bearer ' + token }, signal });
    assert.equal(response.status, 200);
    return response.json();
  };

  const raw = {
    message_id: 'wechat-message', from_user_id: 'wechat-user', message_type: 1, context_token: 'fixture-context',
    item_list: [{ type: 1, text_item: { text: '/blazar Review our design notes' } }],
  };
  const incoming = parseWeixin(raw, wechat);
  assert(incoming);
  const wxChannel = JSON.stringify(['weixin', wechat.botId]);
  store.receiveChannelMessage(owner, wxChannel, workspace, incoming.message, incoming.context);
  store.receiveChannelMessage(owner, wxChannel, workspace, incoming.message, incoming.context);

  const pairing = await post('/v1/pairings', {}, admin);
  assert.equal(pairing.status, 201);
  const phone = await post('/v1/pairings/redeem', { code: (await pairing.json()).code, name: 'iPhone fixture' });
  assert.equal(phone.status, 201);
  const mobile = (await phone.json()).token;

  const { assignment } = await (await socket.request('claim', { capability: 'agent.acp' }, signal)).json();
  const taskId = assignment.task.id;
  const runPath = 'runs/' + assignment.run.id + '/';
  const approval = await socket.request(runPath + 'request-approval', { summary: 'Review the fixture' }, signal);
  assert.equal(approval.status, 200);
  const mobileState = await snapshot(mobile);
  assert.equal(mobileState.tasks.length, 1);
  assert.equal(mobileState.tasks[0].id, taskId);
  assert.equal(mobileState.approvals.length, 1);
  assert.equal(mobileState.approvals[0].taskId, taskId);
  const decision = await post('/v1/tasks/' + taskId + '/commands', {
    action: 'approve', approvalId: mobileState.approvals[0].id, expectedVersion: 1,
  }, mobile, 'phone-decision');
  assert.equal(decision.status, 200);
  assert.equal((await socket.request(runPath + 'consume-approval', { approvalId: mobileState.approvals[0].id }, signal)).status, 200);
  assert.equal((await socket.request(runPath + 'finish', {
    status: 'succeeded', result: 'Reviewed', artifact: { name: 'review.md', text: 'Private review content' },
  }, signal)).status, 200);

  const desktop = await snapshot(admin);
  const artifact = await fetch(new URL('/v1/artifacts/' + desktop.artifacts[0].id, base), {
    headers: { Authorization: 'Bearer ' + admin }, signal,
  });
  assert.equal(await artifact.text(), 'Private review content');
  const receipt = store.leaseWeixinNotice(owner, wxChannel, Date.now(), ['wechat-user'])!;
  assert.doesNotMatch(receipt.text, /Private review content/);
  assert.equal(receipt.context, 'fixture-context');

  const invite = await post('/v1/admin/task-links', { taskId }, admin);
  assert.equal(invite.status, 201);
  const { code } = await invite.json();
  const feishuMessage = (id: string, text: string, rootId = '') => post('/v1/channels/feishu/events', {
    schema: '2.0', header: {
      token: feishu.token, app_id: feishu.appId, tenant_key: feishu.tenant, event_type: 'im.message.receive_v1',
    },
    event: {
      sender: { sender_id: { open_id: 'feishu-user' }, sender_type: 'user' },
      message: { message_id: id, root_id: rootId, chat_id: 'feishu-chat', message_type: 'text',
        content: JSON.stringify({ text }) },
    },
  });
  assert.equal((await feishuMessage('feishu-root', '/blazar /link ' + code)).status, 200);
  assert.equal((await feishuMessage('feishu-status', '/blazar /状态', 'feishu-root')).status, 200);
  const statusNotice = store.leaseChannelNotice(feishuChannel(feishu), Date.now())!;
  assert.equal(statusNotice.messageId, 'feishu-root');
  assert.match(statusNotice.text, /已完成/);
  assert.doesNotMatch(statusNotice.text, /Private review content/);
  assert.equal(store.get(owner, taskId)?.version, 1);
  assert.equal((await feishuMessage('feishu-follow', '/blazar Add recommendations', 'feishu-root')).status, 200);
  const latest = await snapshot(mobile);
  assert.equal(latest.tasks.length, 1);
  assert.equal(latest.tasks[0].id, taskId);
  assert.equal(latest.tasks[0].version, 2);
  assert.equal(store.taskChannels(owner, taskId).length, 2);
  const follow = await (await socket.request('claim', { capability: 'agent.acp' }, signal)).json();
  assert.deepEqual(follow.assignment.instructions, ['Add recommendations']);
});
