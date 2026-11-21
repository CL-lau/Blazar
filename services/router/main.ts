import { configuredPush, startPushDelivery } from './push.ts';
import { configuredDocuments } from '../../packages/apps/config.ts';
import { weixinConfig } from '../../packages/channels/weixin.ts';
import { startWeixin } from './weixin.ts';
import { startWeCom } from './wecom.ts';
import { weComConfig } from '../../packages/channels/wecom.ts';
import { createQQAttachmentReader, createQQSender, qqChannel } from '../../packages/channels/qq.ts';
import { dingTalkConfig, startDingTalk } from './dingtalk.ts';
import { createFeishuSender, feishuChannel } from '../../packages/channels/feishu.ts';
import { piHarness, piMemoryAnswer } from './harness.ts';
import { routerServer, runDueDocumentSync } from './http.ts';
import { MemoryStore } from './memory.ts';
import { TaskStore } from './store.ts';
import { lockRouter } from './instance.ts';

const token = process.env.BLAZAR_ROUTER_TOKEN;
if (!token || token.length < 32) throw new Error('Set BLAZAR_ROUTER_TOKEN to a randomly generated secret');
const port = Number(process.env.BLAZAR_PORT ?? 4199);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BLAZAR_PORT');
const retentionDays = process.env.BLAZAR_PROGRESS_RETENTION_DAYS;
if (retentionDays !== undefined && (!/^[1-9]\d{0,3}$/.test(retentionDays) || Number(retentionDays) > 3_650)) {
  throw new Error('Set BLAZAR_PROGRESS_RETENTION_DAYS to a whole number from 1 to 3650');
}
const progressRetentionMs = retentionDays === undefined ? undefined : Number(retentionDays) * 86_400_000;
const provider = process.env.BLAZAR_MODEL_PROVIDER;
const model = process.env.BLAZAR_MODEL;
if (Boolean(provider) !== Boolean(model)) throw new Error('Set BLAZAR_MODEL_PROVIDER and BLAZAR_MODEL together');
const harness = provider && model ? piHarness(provider, model) : undefined;
const answerMemory = provider && model ? piMemoryAnswer(provider, model) : undefined;
function collaborationConfig(prefix: 'BLAZAR_FEISHU' | 'BLAZAR_LARK') {
  const token = process.env[prefix + '_VERIFY_TOKEN'];
  if (!token) return undefined;
  const values = (suffix: string) => new Set((process.env[prefix + suffix] ?? '').split(',')
    .map(value => value.trim()).filter(Boolean));
  const config = {
    token, appId: process.env[prefix + '_APP_ID'] ?? '', tenant: process.env[prefix + '_TENANT'] ?? '',
    workspace: process.env[prefix + '_WORKSPACE'] ?? '', senders: values('_SENDERS'), chats: values('_CHATS'),
  };
  if (!config.appId || !config.tenant || !config.workspace || !config.senders.size || !config.chats.size) {
    throw new Error('Set all ' + prefix + ' configuration values before enabling the callback');
  }
  return config;
}
const feishu = collaborationConfig('BLAZAR_FEISHU');
const lark = collaborationConfig('BLAZAR_LARK');
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
const memory = new MemoryStore(instance.path);
const store = new TaskStore(instance.path,
  (owner, workspace, refs) => Boolean(memory.resolveAppEvidence(owner, workspace, refs)));
const feishuSecret = process.env.BLAZAR_FEISHU_APP_SECRET;
const feishuSender = feishu && feishuSecret
  ? createFeishuSender(feishu.appId, feishuSecret, process.env.BLAZAR_FEISHU_REGION === 'lark' ? 'lark' : 'feishu')
  : undefined;
const larkSecret = process.env.BLAZAR_LARK_APP_SECRET;
const larkSender = lark && larkSecret ? createFeishuSender(lark.appId, larkSecret, 'lark') : undefined;
const qqMediaHosts = new Set((process.env.BLAZAR_QQ_MEDIA_HOSTS ?? '').split(',')
  .map(host => host.trim().toLowerCase()).filter(Boolean));
const readQQAttachment = qq && qqMediaHosts.size ? createQQAttachmentReader(qqMediaHosts) : undefined;
const dingTalk = dingTalkConfig(process.env);
const wecom = weComConfig(process.env);
const weixin = weixinConfig(process.env);
const server = routerServer(store, { feishu, lark, readFeishuAttachment: feishuSender?.readAttachment, readLarkAttachment: larkSender?.readAttachment, qq, readQQAttachment, documents, owner: 'local', token, memory, harness, answerMemory, pushEnabled: Boolean(push), streamChannels: { weixin, wecom, dingtalk: dingTalk } });
const stopPush = push && startPushDelivery(store, push);
const documentSyncShutdown = new AbortController();
let documentSync: Promise<unknown> | undefined;
const documentSyncTimer = setInterval(() => {
  if (documentSync || !documents.length) return;
  documentSync = runDueDocumentSync(memory, documents, documentSyncShutdown.signal)
    .catch(() => console.error('Document synchronization could not complete'))
    .finally(() => { documentSync = undefined; });
}, 5_000);
documentSyncTimer.unref();
let nextProgressCleanup = 0;
let nextMemoryCleanup = 0;
const cleanupBatch = 1_000;
const watchdog = setInterval(() => {
  const now = Date.now();
  server.expireRuns(now);
  store.watchSilentRuns(now);
  store.updateDeviceReadiness(now);
  server.flushStopNotifications();
  if (progressRetentionMs !== undefined && now >= nextProgressCleanup) {
    const removed = store.pruneProgressEvents(now - progressRetentionMs, cleanupBatch);
    nextProgressCleanup = now + (removed < cleanupBatch ? 60 * 60_000 : 1_000);
  }
  if (now >= nextMemoryCleanup) {
    const removed = memory.pruneExpired(now, cleanupBatch);
    nextMemoryCleanup = now + (removed < cleanupBatch ? 60 * 60_000 : 1_000);
  }
}, 1_000);

const collaborationChannels = [
  { identity: 'feishu' as const, config: feishu, sender: feishuSender, delivery: undefined as Promise<void> | undefined },
  { identity: 'lark' as const, config: lark, sender: larkSender, delivery: undefined as Promise<void> | undefined },
];
const channelDispatcher = setInterval(() => {
  for (const channel of collaborationChannels) {
    const { config, sender, identity } = channel;
    if (!config || !sender || channel.delivery) continue;
    const item = store.leaseChannelNotice(feishuChannel(config, identity), Date.now());
    if (!item) continue;
    if (!config.chats.has(item.chat)) {
      store.finishChannelNotice(item.id, false);
      continue;
    }
    channel.delivery = sender(item.messageId, item.text, item.id)
      .then(() => store.finishChannelNotice(item.id, true))
      .catch(() => console.error(identity + ' notification failed and will be retried'))
      .finally(() => { channel.delivery = undefined; });
  }
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

const stopDingTalk = dingTalk ? startDingTalk(store, 'local', dingTalk, server.flushStopNotifications) : undefined;

const stopWeCom = wecom ? startWeCom(store, 'local', wecom, server.flushStopNotifications) : undefined;

const stopWeixin = weixin ? startWeixin(store, 'local', weixin, server.flushStopNotifications) : undefined;

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopWeixin?.();
  stopWeCom?.();
  stopDingTalk?.();
  clearInterval(documentSyncTimer);
  documentSyncShutdown.abort();
  clearInterval(watchdog);
  clearInterval(channelDispatcher);
  clearInterval(qqDispatcher);
  server.closeDeviceSockets();
  server.close(async () => {
    await Promise.all([...collaborationChannels.map(channel => channel.delivery), qqDelivery, documentSync, stopPush?.()]);
    memory.close();
    store.close();
    instance.release();
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.listen(port, '127.0.0.1', () => console.log(`Blazar is listening on 127.0.0.1:${port}`));
