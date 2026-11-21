import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv } from 'node:crypto';
import { pkcs7Pad } from '@wecom/aibot-node-sdk';
import { receiveWeComEvent } from './wecom.ts';
import { createWeComAttachmentReader, parseWeCom } from '../../packages/channels/wecom.ts';
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

test('WeCom decrypts a bounded file only for its authorized sender and selected task', async t => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const config = {
    botId: 'bot', secret: 'fixture', workspace: 'work',
    senders: new Set(['person', 'another']), chats: new Set(['group:team']),
  };
  const key = Buffer.alloc(32, 17);
  const aeskey = key.toString('base64').replace(/=$/, '');
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(pkcs7Pad(Buffer.from('Encrypted fixtures'), 32)), cipher.final()]);
  const calls: string[] = [];
  const download = createWeComAttachmentReader(new Set(['files.work.weixin.qq.com']), async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    return new Response(Uint8Array.from(encrypted), {
      headers: { 'Content-Disposition': "attachment; filename*=UTF-8''%E7%AC%94%E8%AE%B0.txt" },
    });
  });
  const receive = (msgid: string, body: object) => receiveWeComEvent(store, 'owner', 'wecom', config, {
    aibotid: 'bot', chattype: 'group', chatid: 'team', from: { userid: 'person' }, msgid, ...body,
  }, download);
  const sendText = (id: string, content: string) => receive(id, { msgtype: 'text', text: { content } });
  const file = { msgtype: 'file', file: { url: 'https://files.work.weixin.qq.com/fixture', aeskey } };
  await sendText('root', '/blazar Review notes');
  const [task] = store.snapshot('owner').tasks;
  await receive('unrequested', file);
  await sendText('select', '/blazar follow ' + task.id + ' /attach');
  await receive('unrequested', file);
  await receive('different-sender', { ...file, from: { userid: 'another' } });
  await receive('outside-domain', { ...file, file: { ...file.file, url: 'https://unlisted.qq.com/fixture' } });
  assert.deepEqual(calls, []);
  assert.equal(await receive('accepted', file), true);
  assert.equal(await receive('accepted', file), false);
  assert.equal(calls.length, 1);
  assert.equal(store.get('owner', task.id)?.version, 2);
  assert.deepEqual({ ...store.taskAttachment('owner', task.id, 0) }, { name: '笔记.txt', text: 'Encrypted fixtures' });
  assert.doesNotMatch(JSON.stringify(store.timeline('owner', task.id)), /Encrypted fixtures/);
});
