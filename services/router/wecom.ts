import { WSClient } from '@wecom/aibot-node-sdk';
import { createWeComAttachmentReader, parseWeCom, parseWeComAttachment, type WeComConfig } from '../../packages/channels/wecom.ts';
import type { TaskAttachment } from '../../packages/protocol/task.ts';
import type { TaskStore } from './store.ts';

export async function receiveWeComEvent(store: TaskStore, owner: string, channel: string, config: WeComConfig,
                                        input: unknown, download?: (url: string, key: string) => Promise<TaskAttachment | undefined>,
                                        signal?: AbortSignal) {
  const event = parseWeCom(input, config);
  if (event) {
    if ('taskId' in event && event.text === '/attach') {
      if (download) store.expectChannelAttachment(owner, channel, config.workspace, event, Date.now());
    } else {
      store.receiveChannelMessage(owner, channel, config.workspace, event);
    }
    return true;
  }
  if (!download) return false;
  const file = parseWeComAttachment(input, config);
  if (!file) return false;
  const intent = store.bindChannelAttachment(owner, channel, config.workspace, file, Date.now());
  if (!intent) return false;
  const attachment = await download(file.url, file.aeskey);
  return Boolean(attachment && !signal?.aborted && store.addChannelAttachment(owner, channel, config.workspace, intent.taskId,
    { ...file, taskId: intent.taskId }, attachment, { sender: file.sender, commandId: intent.commandId }));
}

export function startWeCom(store: TaskStore, owner: string, config: WeComConfig, onMessage?: () => void) {
  const channel = JSON.stringify(['wecom', config.botId]);
  const client = new WSClient({
    botId: config.botId, secret: config.secret,
    logger: {
      debug() {}, info() {},
      warn() { console.error('WeCom connection warning'); },
      error() { console.error('WeCom connection error'); },
    },
  });
  let active = true;
  let authenticated = false;
  let delivering = false;
  client.on('authenticated', () => { authenticated = true; });
  client.on('disconnected', () => { authenticated = false; });
  client.on('error', () => console.error('WeCom could not process a connection event'));
  const stop = new AbortController();
  const download = config.mediaHosts?.size ? createWeComAttachmentReader(config.mediaHosts) : undefined;
  const receive = (frame: { body?: unknown }) => {
    if (!active || !authenticated) return;
    void receiveWeComEvent(store, owner, channel, config, frame.body, download, stop.signal)
      .then(changed => { if (active && changed) onMessage?.(); })
      .catch(() => { if (active) console.error('WeCom message was not committed'); });
  };
  client.on('message.text', receive);
  client.on('message.file', receive);
  const dispatcher = setInterval(() => {
    if (!active || !authenticated || !client.isConnected || delivering) return;
    const item = store.leaseChannelNotice(channel, Date.now(), [...config.chats], true);
    if (!item) return;
    delivering = true;
    const chatId = item.chat.slice(item.chat.indexOf(':') + 1);
    void client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: item.text } })
      .then(() => { if (active) store.finishChannelNotice(item.id, true); })
      .catch(() => { if (active) console.error('WeCom notification outcome is unknown'); })
      .finally(() => { delivering = false; });
  }, 1_000);
  dispatcher.unref();
  client.connect();

  return () => {
    active = false;
    stop.abort();
    clearInterval(dispatcher);
    client.disconnect();
  };
}
