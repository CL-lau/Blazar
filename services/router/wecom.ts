import { WSClient } from '@wecom/aibot-node-sdk';
import { parseWeCom, type WeComConfig } from '../../packages/channels/wecom.ts';
import type { TaskStore } from './store.ts';

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
  client.on('message.text', frame => {
    if (!active || !authenticated) return;
    try {
      const message = parseWeCom(frame.body, config);
      if (message) {
        store.receiveChannelMessage(owner, channel, config.workspace, message);
        onMessage?.();
      }
    } catch {
      console.error('WeCom message was not committed');
    }
  });
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
    clearInterval(dispatcher);
    client.disconnect();
  };
}
