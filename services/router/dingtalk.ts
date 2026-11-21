import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { StreamHealth } from './metrics.ts';
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import { createDingTalkAttachmentReader, dingTalkReplyWindow, parseDingTalk, parseDingTalkAttachment, sendDingTalkNotice, type DingTalkConfig, type ReplyWindow } from '../../packages/channels/dingtalk.ts';
import type { TaskStore } from './store.ts';

type ConnectionConfig = DingTalkConfig & { clientId: string; clientSecret: string; workspace: string; mediaHosts?: ReadonlySet<string> };

function replyCipherKey(secret: string) {
  return createHmac('sha256', secret).update('Blazar DingTalk reply window v1').digest();
}

function sealReply(secret: string, window: ReplyWindow, id: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', replyCipherKey(secret), nonce);
  cipher.setAAD(Buffer.from(id));
  const payload = Buffer.concat([cipher.update(window.url.href, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), payload]).toString('base64url');
}

function restoreReply(secret: string, sealed: string, id: string, expires: number, now: number) {
  const bytes = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', replyCipherKey(secret), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const href = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  return dingTalkReplyWindow(JSON.stringify({ sessionWebhook: href, sessionWebhookExpiredTime: expires }), now);
}

export async function deliverDingTalkNotice(store: TaskStore, channel: string, config: ConnectionConfig, transport = fetch, signal?: AbortSignal) {
  const now = Date.now();
  const notice = store.leaseDingTalkNotice(channel, now, [...config.conversations]);
  if (!notice) return false;
  let window: ReplyWindow | undefined;
  try {
    window = restoreReply(config.clientSecret, notice.sealed,
      JSON.stringify([channel, notice.chat, notice.messageId, notice.expires]), notice.expires, now);
  } catch {
    store.finishChannelNotice(notice.id, false);
    return false;
  }
  if (!window) {
    store.finishChannelNotice(notice.id, false);
    return false;
  }
  await sendDingTalkNotice(window, notice.text, transport);
  if (!signal?.aborted) store.finishChannelNotice(notice.id, true);
  return true;
}

export async function receiveDingTalkEvent(store: TaskStore, owner: string, channel: string, config: ConnectionConfig,
                                          raw: string, download?: (code: string) => Promise<string | undefined>,
                                          signal?: AbortSignal) {
  const event = parseDingTalk(raw, config);
  if (event) {
    const now = Date.now();
    const window = dingTalkReplyWindow(raw, now);
    if ('taskId' in event && event.text === '/attach') {
      if (download && event.privateChat) {
        store.expectChannelAttachment(owner, channel, config.workspace, { ...event, taskId: event.taskId }, Date.now());
      }
    } else {
      const sealed = window && sealReply(config.clientSecret, window,
        JSON.stringify([channel, event.chat, event.id, window.expires]));
      store.receiveChannelMessage(owner, channel, config.workspace, { ...event, replyExpires: window?.expires ?? now },
        undefined, sealed);
    }
    return true;
  }
  if (!download) return undefined;
  const file = parseDingTalkAttachment(raw, config);
  if (!file) return undefined;
  const intent = store.bindChannelAttachment(owner, channel, config.workspace, file, Date.now());
  if (!intent) return undefined;
  const message = { ...file, taskId: intent.taskId };
  const text = await download(file.code);
  if (!signal?.aborted && text !== undefined) {
    store.addChannelAttachment(owner, channel, config.workspace, intent.taskId, message, { name: file.name, text },
      { sender: file.sender, commandId: intent.commandId });
  }
  return true;
}

export function startDingTalk(store: TaskStore, owner: string, config: ConnectionConfig, onMessage?: () => void) {
  const channel = JSON.stringify(['dingtalk', config.clientId, config.robotCode]);
  const connectionOptions = { clientId: config.clientId, clientSecret: config.clientSecret, autoReconnect: true };
  const client = new DWClient(connectionOptions);
  const stop = new AbortController();
  const download = config.mediaHosts?.size ? createDingTalkAttachmentReader(config, config.mediaHosts) : undefined;
  let active = true;
  let sending = false;
  let attempted = false;
  const dispatcher = setInterval(() => {
    if (!active || sending) return;
    sending = true;
    void deliverDingTalkNotice(store, channel, config, fetch, stop.signal)
      .catch(() => { if (active) console.error('DingTalk notification outcome is unknown'); })
      .finally(() => { sending = false; });
  }, 1_000);
  dispatcher.unref();
  client.registerCallbackListener(TOPIC_ROBOT, frame => {
    if (!active) return;
    void receiveDingTalkEvent(store, owner, channel, config, frame.data, download, stop.signal).then(receipt => {
      if (!active) return;
      if (receipt) onMessage?.();
      if (frame.headers.messageId) client.socketCallBackResponse(frame.headers.messageId, { success: true });
    }).catch(() => { if (active) console.error('DingTalk callback was not committed'); });
  });
  void client.connect().then(() => {
    attempted = true;
    if (!active) client.disconnect();
  }).catch(() => {
    attempted = true;
    if (active) console.error('DingTalk connection failed');
  });
  return {
    health: (): StreamHealth => client.connected && client.registered ? 'available' : attempted ? 'unavailable' : 'starting',
    stop() {
      active = false;
      stop.abort();
      clearInterval(dispatcher);
      client.disconnect();
    },
  };
}

export function dingTalkConfig(env: NodeJS.ProcessEnv): ConnectionConfig | undefined {
  const clientId = env.BLAZAR_DINGTALK_CLIENT_ID;
  const clientSecret = env.BLAZAR_DINGTALK_CLIENT_SECRET;
  if (!clientId && !clientSecret) return undefined;
  const robotCode = env.BLAZAR_DINGTALK_ROBOT_CODE;
  const workspace = env.BLAZAR_DINGTALK_WORKSPACE;
  const split = (value = '') => new Set(value.split(',').map(item => item.trim()).filter(Boolean));
  const senders = split(env.BLAZAR_DINGTALK_SENDERS);
  const conversations = split(env.BLAZAR_DINGTALK_CONVERSATIONS);
  if (!clientId || !clientSecret || !robotCode || !workspace || !senders.size || !conversations.size) {
    throw new Error('Set all Blazar DingTalk configuration values before enabling Stream mode');
  }
  const mediaHosts = split(env.BLAZAR_DINGTALK_MEDIA_HOSTS?.toLowerCase());
  return { clientId, clientSecret, robotCode, workspace, senders, conversations, mediaHosts };
}
