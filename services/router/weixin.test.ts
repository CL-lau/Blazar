import assert from 'node:assert/strict';
import test from 'node:test';
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
