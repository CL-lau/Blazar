import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv } from 'node:crypto';
import { receiveWeixinEvent } from './weixin.ts';
import { TaskStore } from './store.ts';
import { parseWeixin, weixinConfig, weixinTransport } from '../../packages/channels/weixin.ts';

test('Weixin preserves large message IDs and uses the authorized conversation context for replies', async () => {
  const config = {
    token: 'fixture', botId: 'bot', base: 'https://ilinkai.weixin.qq.com',
    workspace: 'work', senders: new Set(['person']),
  };
  assert.throws(() => weixinConfig({
    BLAZAR_WEIXIN_TOKEN: 'fixture', BLAZAR_WEIXIN_BOT_ID: 'bot', BLAZAR_WEIXIN_BASE_URL: 'https://other.example',
  }));
  const calls: [string, RequestInit | undefined][] = [];
  const transport = weixinTransport(config, async (url, init) => {
    calls.push([String(url), init]);
    return new Response(calls.length === 1 ?
      '{"ret":0,"get_updates_buf":"next","msgs":[{"from_user_id":"person","message_id":18446744073709551615,"message_type":1,"context_token":"ctx","item_list":[{"type":1,"text_item":{"text":"/blazar Review the notes"}}]}]}' :
      '{"ret":0}');
  });
  const signal = new AbortController().signal;
  const batch = await transport.poll('old', signal);
  assert.equal(batch.cursor, 'next');
  const parsed = parseWeixin(batch.messages[0], config)!;
  assert.equal(parsed.message.id, '18446744073709551615');
  assert.equal(parsed.message.text, 'Review the notes');
  assert.equal(parseWeixin({ ...(batch.messages[0] as object), group_id: 'group' }, config), undefined);
  await assert.rejects(transport.send('different', 'ctx', 'notice', 'Completed', signal));
  await transport.send(parsed.message.chat, parsed.context!, 'notice', 'Completed', signal);
  assert.match(calls[1][0], /\/sendmessage$/);
  const payload = JSON.parse(String(calls[1][1]?.body));
  assert.equal(payload.msg.to_user_id, 'person');
  assert.equal(payload.msg.context_token, 'ctx');
});

test('WeChat keeps its reply context across Router restart without retrying unknown deliveries', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { TaskStore } = await import('./store.ts');
  const dir = mkdtempSync(join(tmpdir(), 'blazar-weixin-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'router.sqlite');
  const channel = JSON.stringify(['weixin', 'bot']);
  const message = { id: 'msg', thread: 'msg', chat: 'user', root: true, text: 'Review notes' };
  const before = new TaskStore(path);
  before.receiveChannelMessage('owner', channel, 'work', message, 'authorized-context');
  before.receiveChannelMessage('owner', channel, 'work', message, 'duplicate-must-not-replace-context');
  const run = before.claim('owner', 'work', 'device', Date.now(), 45_000)!;
  assert.equal(before.finish(run.run.id, 'device', Date.now(), { status: 'succeeded', result: 'Private result' }), true);
  before.close();

  const after = new TaskStore(path);
  try {
    assert.equal(after.leaseWeixinNotice('other', channel, Date.now(), ['user']), undefined);
    assert.equal(after.leaseWeixinNotice('owner', channel, Date.now(), ['different-user']), undefined);
    const notice = after.leaseWeixinNotice('owner', channel, Date.now(), ['user'])!;
    assert.equal(notice.context, 'authorized-context');
    assert.doesNotMatch(notice.text, /Private result/);
    assert.equal(after.leaseWeixinNotice('owner', channel, Date.now() + 60_000, ['user']), undefined);
  } finally {
    after.close();
  }
});

test('Weixin imports bounded encrypted text from the official CDN for a selected private task', async t => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const config = { token: 'fixture', botId: 'bot', base: 'https://ilinkai.weixin.qq.com',
    workspace: 'work', senders: new Set(['person', 'other']) };
  const key = Buffer.alloc(16, 42);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update('Weixin fixture text'), cipher.final()]);
  const requests: string[] = [];
  const transport = weixinTransport(config, async (url, init) => {
    requests.push(String(url));
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    return new Response(Uint8Array.from(encrypted));
  });
  const signal = AbortSignal.timeout(4_000);
  const receive = (id: string, item: object, extra: object = {}) => receiveWeixinEvent(store, 'owner', 'weixin', config, {
    from_user_id: 'person', message_type: 1, message_id: id, item_list: [item], ...extra,
  }, transport.downloadAttachment, signal);
  const sendText = (id: string, text: string) => receive(id, { type: 1, text_item: { text } });
  const file = (media: object, len = '19') => ({ type: 4, file_item: { file_name: 'notes.txt', len, media } });
  const media = { encrypt_query_param: 'fixture+param', aes_key: Buffer.from(key.toString('hex')).toString('base64') };
  await sendText('root', '/blazar Review the file');
  const [task] = store.snapshot('owner').tasks;
  await receive('unrequested', file(media));
  const select = (id: string) => sendText(id, '/blazar follow ' + task.id + ' /attach');
  await select('select');
  await receive('unrequested', file(media));
  await receive('different-sender', file(media), { from_user_id: 'other' });
  await receive('group', file(media), { group_id: 'team' });
  await receive('wrong-host', file({ full_url: 'https://other.example/download', aes_key: media.aes_key }));
  await receive('large', file(media, '8193'));
  assert.deepEqual(requests, []);
  assert.equal(await receive('accepted', file(media)), true);
  assert.equal(await receive('accepted', file(media)), false);
  assert.deepEqual(requests, ['https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=fixture%2Bparam']);
  assert.deepEqual({ ...store.taskAttachment('owner', task.id, 0) }, { name: 'notes.txt', text: 'Weixin fixture text' });

  await select('select-raw-key');
  assert.equal(await receive('raw-key', file({
    full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=direct',
    aes_key: key.toString('base64'),
  })), true);
  assert.equal(requests.length, 2);
  assert.equal(store.taskAttachment('owner', task.id, 1)?.text, 'Weixin fixture text');
});
