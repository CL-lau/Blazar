import { configuredPush, startPushDelivery } from './push.ts';
import { configuredDocuments } from '../../packages/apps/config.ts';
import { weixinConfig } from '../../packages/channels/weixin.ts';
import { startWeixin } from './weixin.ts';
import { startWeCom } from './wecom.ts';
import { weComConfig } from '../../packages/channels/wecom.ts';
import { createQQSender, qqChannel } from '../../packages/channels/qq.ts';
import { dingTalkConfig, startDingTalk } from './dingtalk.ts';
import { createFeishuSender, feishuChannel } from '../../packages/channels/feishu.ts';
import { piHarness, piMemoryAnswer } from './harness.ts';
import { routerServer } from './http.ts';
import { MemoryStore } from './memory.ts';
import { TaskStore } from './store.ts';
import { lockRouter } from './instance.ts';

const token = process.env.BLAZAR_ROUTER_TOKEN;
if (!token || token.length < 32) throw new Error('Set BLAZAR_ROUTER_TOKEN to a randomly generated secret');
const port = Number(process.env.BLAZAR_PORT ?? 4199);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BLAZAR_PORT');
const provider = process.env.BLAZAR_MODEL_PROVIDER;
const model = process.env.BLAZAR_MODEL;
if (Boolean(provider) !== Boolean(model)) throw new Error('Set BLAZAR_MODEL_PROVIDER and BLAZAR_MODEL together');
const harness = provider && model ? piHarness(provider, model) : undefined;
const answerMemory = provider && model ? piMemoryAnswer(provider, model) : undefined;
const feishuToken = process.env.BLAZAR_FEISHU_VERIFY_TOKEN;
const feishu = feishuToken ? {
  token: feishuToken,
  appId: process.env.BLAZAR_FEISHU_APP_ID ?? '',
  tenant: process.env.BLAZAR_FEISHU_TENANT ?? '',
  workspace: process.env.BLAZAR_FEISHU_WORKSPACE ?? '',
  senders: new Set((process.env.BLAZAR_FEISHU_SENDERS ?? '').split(',').map(value => value.trim()).filter(Boolean)),
  chats: new Set((process.env.BLAZAR_FEISHU_CHATS ?? '').split(',').map(value => value.trim()).filter(Boolean)),
} : undefined;
if (feishu && (!feishu.appId || !feishu.tenant || !feishu.workspace || !feishu.senders.size || !feishu.chats.size)) {
  throw new Error('Set all Blazar Feishu configuration values before enabling the callback');
}
const qqSecret = process.env.BLAZAR_QQ_SECRET;
const qq = qqSecret ? {
  secret: qqSecret, appId: process.env.BLAZAR_QQ_APP_ID ?? '',
  workspace: process.env.BLAZAR_QQ_WORKSPACE ?? '',
  senders: new Set((process.env.BLAZAR_QQ_SENDERS ?? '').split(',').map(value => value.trim()).filter(Boolean)),
  chats: new Set((process.env.BLAZAR_QQ_CHATS ?? '').split(',').map(value => value.trim()).filter(Boolean)),
} : undefined;
if (qq && (!qq.appId || !qq.workspace || !qq.senders.size || !qq.chats.size)) {
  throw new Error('Set all Blazar QQ configuration values before enabling the callback');
}
const documents = configuredDocuments(process.env);
const push = configuredPush(process.env);
const instance = lockRouter(process.env.BLAZAR_DB ?? 'blazar.sqlite');
const store = new TaskStore(instance.path);
const memory = new MemoryStore(instance.path);
const server = routerServer(store, { feishu, qq, documents, owner: 'local', token, memory, harness, answerMemory, pushEnabled: Boolean(push) });
const stopPush = push && startPushDelivery(store, push);
const watchdog = setInterval(() => {
  const now = Date.now();
  store.expire(now);
  store.updateDeviceReadiness(now);
  server.flushStopNotifications();
}, 1_000);

const feishuSecret = process.env.BLAZAR_FEISHU_APP_SECRET;
const feishuSender = feishu && feishuSecret
  ? createFeishuSender(feishu.appId, feishuSecret, process.env.BLAZAR_FEISHU_REGION === 'lark' ? 'lark' : 'feishu')
  : undefined;
let delivery: Promise<void> | undefined;
const channelDispatcher = setInterval(() => {
  if (!feishu || !feishuSender || delivery) return;
  const item = store.leaseChannelNotice(feishuChannel(feishu), Date.now());
  if (!item) return;
  if (!feishu.chats.has(item.chat)) {
    store.finishChannelNotice(item.id, false);
    return;
  }
  delivery = feishuSender(item.messageId, item.text, item.id)
    .then(() => store.finishChannelNotice(item.id, true))
    .catch(() => console.error('Feishu notification failed and will be retried'))
    .finally(() => { delivery = undefined; });
}, 1_000);
channelDispatcher.unref();

const qqSender = qq ? createQQSender(qq) : undefined;
let qqDelivery: Promise<void> | undefined;
const qqDispatcher = setInterval(() => {
  if (!qq || !qqSender || qqDelivery) return;
  const notice = store.leasePassiveNotice(qqChannel(qq), Date.now(), [...qq.chats]);
  if (!notice) return;
  qqDelivery = qqSender(notice)
    .then(() => store.finishChannelNotice(notice.id, true))
    .catch(() => console.error('QQ notification outcome is unknown'))
    .finally(() => { qqDelivery = undefined; });
}, 1_000);
qqDispatcher.unref();

const dingTalk = dingTalkConfig(process.env);
const stopDingTalk = dingTalk ? startDingTalk(store, 'local', dingTalk) : undefined;

const wecom = weComConfig(process.env);
const stopWeCom = wecom ? startWeCom(store, 'local', wecom) : undefined;

const weixin = weixinConfig(process.env);
const stopWeixin = weixin ? startWeixin(store, 'local', weixin) : undefined;

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopWeixin?.();
  stopWeCom?.();
  stopDingTalk?.();
  clearInterval(watchdog);
  clearInterval(channelDispatcher);
  clearInterval(qqDispatcher);
  server.closeDeviceSockets();
  server.close(async () => {
    await Promise.all([delivery, qqDelivery, stopPush?.()]);
    memory.close();
    store.close();
    instance.release();
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.listen(port, '127.0.0.1', () => console.log(`Blazar is listening on 127.0.0.1:${port}`));
