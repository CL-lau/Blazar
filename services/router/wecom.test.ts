import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWeCom } from '../../packages/channels/wecom.ts';
import { TaskStore } from './store.ts';

test('WeCom isolates bot, sender and chat and preserves the notification destination', t => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const config = {
    botId: 'bot', secret: 'fixture', workspace: 'work',
    senders: new Set(['person']), chats: new Set(['single:person', 'group:team']),
  };
  const frame = (id: string, content: string) => ({
    aibotid: 'bot', chattype: 'group', chatid: 'team', from: { userid: 'person' },
    msgid: id, msgtype: 'text', text: { content },
  });
  const original = frame('msg', '/blazar Review notes');
  assert.equal(parseWeCom({ ...original, aibotid: 'other' }, config), undefined);
  assert.equal(parseWeCom({ ...original, chatid: 'other' }, config), undefined);
  assert.equal(parseWeCom({ ...original, from: { userid: 'other' } }, config), undefined);
  const message = parseWeCom(original, config)!;
  store.receiveChannelMessage('owner', 'wecom', 'work', message);
  store.receiveChannelMessage('owner', 'wecom', 'work', message);
  assert.equal(store.snapshot('owner').tasks.length, 1);
  const { run } = store.claim('owner', 'work', 'device', Date.now(), 45_000)!;
  store.finish(run.id, 'device', Date.now(), { status: 'succeeded', result: 'Private output' });
  assert.equal(store.leaseChannelNotice('wecom', Date.now(), ['single:person'], true), undefined);
  const notice = store.leaseChannelNotice('wecom', Date.now(), ['group:team'], true)!;
  assert.equal(notice.chat, 'group:team');
  assert.doesNotMatch(notice.text, /Private output/);
  assert.equal(store.leaseChannelNotice('wecom', Date.now() + 30_000, ['group:team'], true), undefined);
});
