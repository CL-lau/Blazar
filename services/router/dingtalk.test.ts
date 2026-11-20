import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskStore } from './store.ts';
import { dingTalkReplyWindow, parseDingTalk, sendDingTalkNotice } from '../../packages/channels/dingtalk.ts';

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
