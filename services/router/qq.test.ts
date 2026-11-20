import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import test from 'node:test';
import { createQQHandler, createQQSender } from '../../packages/channels/qq.ts';
import { TaskStore } from './store.ts';

test('QQ matches the official challenge signature and rejects tampered or stale callbacks', () => {
  const config = {
    secret: 'naOC0ocQE3shWLAfffVLB1rhYPG7', appId: 'app', workspace: 'workspace',
    chats: new Set<string>(), senders: new Set<string>(),
  };
  const handle = createQQHandler(config);
  const raw = Buffer.from('{ "op": 0,"d": {}, "t": "GATEWAY_EVENT_NAME"}');
  const timestamp = '1725442341';
  const signature = '2eb9983ebb8bb209e78fd095942f58e442656656e7975d01e64f9023a84b7c964290fdd40e5500c33867ccfe9563b7e0b6bac0e1d42c13e787b304fd51f71102';
  const body = JSON.parse(raw.toString());
  const now = Number(timestamp) * 1_000;
  assert.equal(handle(body, raw, timestamp, signature, now).kind, 'ignore');
  assert.equal(handle(body, Buffer.concat([raw, Buffer.from(' ')]), timestamp, signature, now).kind, 'unauthorized');
  assert.equal(handle(body, raw, timestamp, signature, now + 301_000).kind, 'unauthorized');
  const challenge = createQQHandler({ ...config, secret: 'DG5g3B4j9X2KOErG' });
  const response = challenge({ op: 13, d: { plain_token: 'Arq0D5A61EgUu4OxUvOp', event_ts: timestamp } },
    Buffer.alloc(0), undefined, undefined, now);
  assert.deepEqual(response, {
    kind: 'challenge', plain_token: 'Arq0D5A61EgUu4OxUvOp',
    signature: '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706',
  });
});

test('authorized QQ messages deduplicate and can follow a task from their own chat', t => {
  const secret = 'test-bot-secret';
  const handle = createQQHandler({ secret, appId: 'app', workspace: 'work',
    chats: new Set(['c2c:sender', 'c2c:other']), senders: new Set(['sender', 'other']),
  });
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const privateKey = createPrivateKey({
    key: Buffer.from('302e020100300506032b657004220420' + Buffer.from(secret.repeat(3).slice(0, 32)).toString('hex'), 'hex'),
    format: 'der', type: 'pkcs8',
  });
  function message(id: string, sender: string, content: string) {
    const body = { op: 0, t: 'C2C_MESSAGE_CREATE', d: { id, author: { user_openid: sender }, content } };
    const raw = Buffer.from(JSON.stringify(body));
    const now = Date.now();
    const time = String(Math.floor(now / 1_000));
    const signature = sign(null, Buffer.concat([Buffer.from(time), raw]), privateKey).toString('hex');
    const result = handle(body, raw, time, signature, now);
    if (result.kind === 'message') store.receiveChannelMessage('owner', 'qq', 'work', result.message);
  }
  message('unlisted', 'third', '/blazar Review notes');
  assert.equal(store.snapshot('owner').tasks.length, 0);
  message('root', 'sender', '/blazar Review notes');
  message('root', 'sender', '/blazar Review notes');
  const [task] = store.snapshot('owner').tasks;
  assert.equal(store.snapshot('owner').tasks.length, 1);
  message('other', 'other', '/blazar follow ' + task.id + ' Add examples');
  assert.equal(store.get('owner', task.id)?.version, 1);
  message('follow', 'sender', '/blazar follow ' + task.id + ' Add examples');
  assert.equal(store.get('owner', task.id)?.version, 2);
});

test('QQ sends only to the original reply window and reserves distinct passive reply sequences', async t => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const now = Date.now();
  const chat = 'group:demo';
  const expires = now + 300_000;
  store.receiveChannelMessage('owner', 'qq', 'work', {
    id: 'root', chat, thread: 'root', root: true, text: 'Review the notes', replyExpires: expires,
  });
  const [task] = store.snapshot('owner').tasks;
  for (let pass = 0; pass < 2; pass++) {
    if (pass) store.command('owner', task.id, 1, { action: 'append', text: 'Review again' });
    const { run } = store.claim('owner', 'work', 'device', now, 45_000)!;
    store.finish(run.id, 'device', now, { status: 'succeeded', result: 'private text' });
  }
  assert.equal(store.leasePassiveNotice('qq', expires, [chat]), undefined);
  assert.equal(store.leasePassiveNotice('qq', now, ['group:other']), undefined);
  const first = store.leasePassiveNotice('qq', now, [chat])!;
  const second = store.leasePassiveNotice('qq', now, [chat])!;
  assert.deepEqual([first.seq, second.seq], [1, 2]);
  assert.equal(store.leasePassiveNotice('qq', now, [chat]), undefined);
  const calls: [string, RequestInit | undefined][] = [];
  const sender = createQQSender({ appId: 'app', secret: 'test-secret', workspace: 'work',
    chats: new Set([chat]), senders: new Set() }, async (url, init) => {
    calls.push([String(url), init]);
    return Response.json(calls.length === 1 ? { access_token: 'token', expires_in: 3600 } : { id: 'sent' });
  });
  await sender(first);
  assert.equal(calls[1][0], 'https://api.sgroup.qq.com/v2/groups/demo/messages');
  const body = JSON.parse(String(calls[1][1]?.body));
  assert.equal(body.msg_id, 'root');
  assert.equal(body.msg_seq, 1);
  assert.doesNotMatch(body.content, /private text/);
});
