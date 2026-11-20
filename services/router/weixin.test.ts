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
