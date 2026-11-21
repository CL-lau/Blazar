import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskStore } from './store.ts';
import { receiveDingTalkEvent } from './dingtalk.ts';
import { createDingTalkAttachmentReader, dingTalkReplyWindow, parseDingTalk, sendDingTalkNotice } from '../../packages/channels/dingtalk.ts';

test('DingTalk Stream events deduplicate and can follow tasks only from their original conversation', t => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const config = { robotCode: 'robot', senders: new Set(['sender']), conversations: new Set(['chat', 'other-chat']) };
  const event = (id: string, content: string, overrides = {}) => JSON.stringify({
    robotCode: 'robot', senderStaffId: 'sender', conversationId: 'chat',
    msgId: id, msgtype: 'text', text: { content }, ...overrides,
  });
  function receive(raw: string) {
    const parsed = parseDingTalk(raw, config);
    if (parsed) store.receiveChannelMessage('owner', 'dingtalk', 'workspace', parsed);
  }
  receive(event('wrong', '/blazar Review notes', { robotCode: 'other-robot' }));
  receive(event('unlisted', '/blazar Review notes', { senderStaffId: 'other-sender' }));
  assert.equal(store.snapshot('owner').tasks.length, 0);
  receive(event('root', '/blazar Review notes'));
  receive(event('root', '/blazar Review notes'));
  assert.equal(store.snapshot('owner').tasks.length, 1);
  const [task] = store.snapshot('owner').tasks;
  const follow = '/blazar follow ' + task.id + ' Include the summary';
  receive(event('wrong-chat', follow, { conversationId: 'other-chat' }));
  assert.equal(store.get('owner', task.id)?.version, 1);
  receive(event('follow-up', follow));
  receive(event('follow-up', follow));
  assert.equal(store.get('owner', task.id)?.version, 2);
  assert.equal(store.timeline('owner', task.id)?.events[0].data.text, 'Include the summary');
});

test('DingTalk notices use an unexpired official reply window and do not retry unknown outcomes', async t => {
  const now = Date.now();
  const raw = (sessionWebhook: string, sessionWebhookExpiredTime = now + 60_000) =>
    JSON.stringify({ sessionWebhook, sessionWebhookExpiredTime });
  assert.equal(dingTalkReplyWindow(raw('https://other.example/robot/sendBySession?session=abc'), now), undefined);
  const address = 'https://oapi.dingtalk.com/robot/sendBySession?session=abc';
  assert.equal(dingTalkReplyWindow(raw(address, now), now), undefined);
  const window = dingTalkReplyWindow(raw(address), now)!;
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  store.receiveChannelMessage('owner', 'dingtalk', 'workspace', {
    id: 'msg', chat: 'chat', thread: 'msg', root: true, text: 'Review notes',
  });
  const { run } = store.claim('owner', 'workspace', 'device', now, 45_000)!;
  assert.equal(store.finish(run.id, 'device', now, { status: 'succeeded', result: 'Private' }), true);
  assert.equal(store.leaseChannelNotice('dingtalk', Date.now(), ['different-chat'], true), undefined);
  const notice = store.leaseChannelNotice('dingtalk', Date.now(), ['chat'], true)!;
  assert.doesNotMatch(notice.text, /Private/);
  await assert.rejects(sendDingTalkNotice(window, notice.text, async (url, init) => {
    assert.equal(String(url), address);
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init?.body)), { msgtype: 'text', text: { content: notice.text } });
    throw new Error('Connection lost after possible delivery');
  }));
  assert.equal(store.leaseChannelNotice('dingtalk', Date.now() + 31_000, ['chat'], true), undefined);
});

test('a DingTalk private file consumes only its sender’s pending task attachment request', async t => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const config = { clientId: 'app', clientSecret: 'secret', robotCode: 'robot', workspace: 'workspace',
    senders: new Set(['sender', 'other']), conversations: new Set(['chat', 'other-chat']) };
  const channel = JSON.stringify(['dingtalk', 'app', 'robot']);
  const requests: string[] = [];
  const download = createDingTalkAttachmentReader(config, new Set(['files.dingtalk.com']), async (url, init) => {
    const address = String(url);
    requests.push(address);
    assert.equal(init?.redirect, 'error');
    if (address.endsWith('/oauth2/accessToken')) {
      assert.deepEqual(JSON.parse(String(init?.body)), { appKey: 'app', appSecret: 'secret' });
      return Response.json({ accessToken: 'token', expireIn: 3600 });
    }
    if (address.endsWith('/robot/messageFiles/download')) {
      assert.equal(new Headers(init?.headers).get('x-acs-dingtalk-access-token'), 'token');
      assert.deepEqual(JSON.parse(String(init?.body)), { robotCode: 'robot', downloadCode: 'fixture-code' });
      return Response.json({ downloadUrl: 'https://files.dingtalk.com/download' });
    }
    assert.equal(new Headers(init?.headers).has('x-acs-dingtalk-access-token'), false);
    return new Response('DingTalk fixture text');
  });
  const receive = (body: object) => receiveDingTalkEvent(store, 'owner', channel, config, JSON.stringify({
    robotCode: 'robot', senderStaffId: 'sender', conversationType: '1', conversationId: 'chat', ...body,
  }), download);
  const sendText = (id: string, content: string) => receive({ msgId: id, msgtype: 'text', text: { content } });
  const sendFile = (id: string, overrides: object = {}) => receive({ msgId: id, msgtype: 'file',
    content: { fileName: 'notes.txt', downloadCode: 'fixture-code' }, ...overrides });
  await sendText('root', '/blazar Summarize the attachment');
  const [task] = store.snapshot('owner').tasks;
  await sendFile('before-selection');
  await sendText('select', '/blazar follow ' + task.id + ' /attach');
  await sendFile('before-selection');
  await sendFile('other-sender', { senderStaffId: 'other' });
  await sendFile('other-chat', { conversationId: 'other-chat' });
  await sendFile('group', { conversationType: '2' });
  assert.deepEqual(requests, []);
  await sendFile('attachment');
  await sendFile('attachment');
  await sendText('select', '/blazar follow ' + task.id + ' /attach');
  await sendFile('second-without-selection');
  assert.equal(requests.length, 3);
  assert.equal(store.get('owner', task.id)?.version, 2);
  assert.deepEqual({ ...store.taskAttachment('owner', task.id, 0) }, { name: 'notes.txt', text: 'DingTalk fixture text' });
  assert.equal(store.taskAttachment('owner', task.id, 1), undefined);

  await sendText('another-root', '/blazar Summarize a different file');
  const another = store.snapshot('owner').tasks.find(item => item.id !== task.id)!;
  await sendText('select-first', '/blazar follow ' + task.id + ' /attach');
  const pending = Promise.withResolvers<string>();
  const racingFile = JSON.stringify({
    robotCode: 'robot', senderStaffId: 'sender', conversationType: '1', conversationId: 'chat',
    msgId: 'in-flight', msgtype: 'file', content: { fileName: 'notes.txt', downloadCode: 'fixture-code' },
  });
  const received = receiveDingTalkEvent(store, 'owner', channel, config, racingFile, () => pending.promise);
  await sendText('select-second', '/blazar follow ' + another.id + ' /attach');
  pending.resolve('First task input');
  await received;
  await sendFile('in-flight');
  assert.equal(requests.length, 3);
  assert.equal(store.taskAttachment('owner', task.id, 1), undefined);
  assert.equal(store.taskAttachment('owner', another.id, 0), undefined);
  await sendFile('fresh');
  assert.equal(requests.length, 5);
  assert.equal(store.taskAttachment('owner', another.id, 0)?.text, 'DingTalk fixture text');
});
