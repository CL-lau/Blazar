import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import { dingTalkReplyWindow, parseDingTalk, sendDingTalkNotice, type DingTalkConfig, type ReplyWindow } from '../../packages/channels/dingtalk.ts';
import type { TaskStore } from './store.ts';

type ConnectionConfig = DingTalkConfig & { clientId: string; clientSecret: string; workspace: string };

export function startDingTalk(store: TaskStore, owner: string, config: ConnectionConfig, onMessage?: () => void) {
  const channel = JSON.stringify(['dingtalk', config.clientId, config.robotCode]);
  const connectionOptions = { clientId: config.clientId, clientSecret: config.clientSecret, autoReconnect: true };
  const client = new DWClient(connectionOptions);
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
    try {
      const event = parseDingTalk(frame.data, config);
      if (event) {
        store.receiveChannelMessage(owner, channel, config.workspace, event);
        onMessage?.();
        const window = dingTalkReplyWindow(frame.data, Date.now());
        if (window) windows.set(event.chat, window);
      }
      if (frame.headers.messageId) client.socketCallBackResponse(frame.headers.messageId, { success: true });
    } catch {
      console.error('DingTalk callback was not committed');
    }
  });
  void client.connect().then(() => {
    if (!active) client.disconnect();
  }).catch(() => {
    if (active) console.error('DingTalk connection failed');
  });
  return () => {
    active = false;
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
  return { clientId, clientSecret, robotCode, workspace, senders, conversations };
}
