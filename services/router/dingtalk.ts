import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import { createDingTalkAttachmentReader, dingTalkReplyWindow, parseDingTalk, parseDingTalkAttachment, sendDingTalkNotice, type DingTalkConfig, type ReplyWindow } from '../../packages/channels/dingtalk.ts';
import type { TaskStore } from './store.ts';

type ConnectionConfig = DingTalkConfig & { clientId: string; clientSecret: string; workspace: string; mediaHosts?: ReadonlySet<string> };

export async function receiveDingTalkEvent(store: TaskStore, owner: string, channel: string, config: ConnectionConfig,
                                          raw: string, download?: (code: string) => Promise<string | undefined>,
                                          signal?: AbortSignal) {
  const event = parseDingTalk(raw, config);
  if (event) {
    if ('taskId' in event && event.text === '/attach') {
      if (download && event.privateChat) {
        store.expectChannelAttachment(owner, channel, config.workspace, { ...event, taskId: event.taskId }, Date.now());
      }
    } else {
      store.receiveChannelMessage(owner, channel, config.workspace, event);
    }
    return event.chat;
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
  return file.chat;
}

export function startDingTalk(store: TaskStore, owner: string, config: ConnectionConfig, onMessage?: () => void) {
  const channel = JSON.stringify(['dingtalk', config.clientId, config.robotCode]);
  const connectionOptions = { clientId: config.clientId, clientSecret: config.clientSecret, autoReconnect: true };
  const client = new DWClient(connectionOptions);
  const stop = new AbortController();
  const download = config.mediaHosts?.size ? createDingTalkAttachmentReader(config, config.mediaHosts) : undefined;
  let active = true;
  let sending = false;
  const windows = new Map<string, ReplyWindow>();
  const dispatcher = setInterval(() => {
    if (!active || sending) return;
    const now = Date.now();
    for (const [chat, window] of windows) {
      if (window.expires <= now) windows.delete(chat);
    }
    if (!windows.size) return;
    // DingTalk's session reply has no idempotency key. Record the attempt before sending.
    const notice = store.leaseChannelNotice(channel, now, [...windows.keys()], true);
    if (!notice) return;
    sending = true;
    void sendDingTalkNotice(windows.get(notice.chat)!, notice.text)
      .then(() => { if (active) store.finishChannelNotice(notice.id, true); })
      .catch(() => { if (active) console.error('DingTalk notification outcome is unknown'); })
      .finally(() => { sending = false; });
  }, 1_000);
  dispatcher.unref();
  client.registerCallbackListener(TOPIC_ROBOT, frame => {
    if (!active) return;
    void receiveDingTalkEvent(store, owner, channel, config, frame.data, download, stop.signal).then(chat => {
      if (!active) return;
      if (chat) {
        onMessage?.();
        const window = dingTalkReplyWindow(frame.data, Date.now());
        if (window) windows.set(chat, window);
      }
      if (frame.headers.messageId) client.socketCallBackResponse(frame.headers.messageId, { success: true });
    }).catch(() => { if (active) console.error('DingTalk callback was not committed'); });
  });
  void client.connect().then(() => {
    if (!active) client.disconnect();
  }).catch(() => {
    if (active) console.error('DingTalk connection failed');
  });
  return () => {
    active = false;
    stop.abort();
    clearInterval(dispatcher);
    client.disconnect();
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
