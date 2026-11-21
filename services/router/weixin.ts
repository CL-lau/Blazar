import type { StreamHealth } from './metrics.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { parseWeixin, parseWeixinAttachment, weixinTransport, type WeixinConfig } from '../../packages/channels/weixin.ts';
import type { TaskStore } from './store.ts';

export async function receiveWeixinEvent(store: TaskStore, owner: string, channel: string, config: WeixinConfig,
                                         raw: unknown, download: ReturnType<typeof weixinTransport>['downloadAttachment'],
                                         signal: AbortSignal) {
  const event = parseWeixin(raw, config);
  if (event) {
    if ('taskId' in event.message && event.message.text === '/attach') {
      const message = event.message;
      if (message.taskId) store.expectChannelAttachment(owner, channel, config.workspace,
        { ...message, taskId: message.taskId, sender: message.chat }, Date.now());
    } else {
      store.receiveChannelMessage(owner, channel, config.workspace, event.message, event.context);
    }
    return true;
  }
  const file = parseWeixinAttachment(raw, config);
  if (!file) return false;
  const intent = store.bindChannelAttachment(owner, channel, config.workspace, file, Date.now());
  if (!intent) return false;
  const text = await download(file, signal);
  return !signal.aborted && text !== undefined && store.addChannelAttachment(owner, channel, config.workspace, intent.taskId,
    { ...file, taskId: intent.taskId }, { name: file.name, text }, { sender: file.sender, commandId: intent.commandId });
}

export function startWeixin(store: TaskStore, owner: string, config: WeixinConfig, onMessage?: () => void) {
  const stop = new AbortController();
  const channel = JSON.stringify(['weixin', config.botId]);
  const transport = weixinTransport(config);
  let health: StreamHealth = 'starting';
  const poll = async () => {
    while (!stop.signal.aborted) {
      try {
        const current = store.channelCursor(channel);
        const batch = await transport.poll(current, stop.signal);
        if (stop.signal.aborted) return;
        for (const raw of batch.messages) {
          if (await receiveWeixinEvent(store, owner, channel, config, raw, transport.downloadAttachment, stop.signal)) {
            onMessage?.();
          }
          if (stop.signal.aborted) return;
        }
        health = 'available';
        if (batch.cursor !== current) store.saveChannelCursor(channel, batch.cursor);
        if (batch.messages.length) continue;
      } catch {
        if (!stop.signal.aborted) {
          health = 'unavailable';
          console.error('Weixin polling did not complete');
        }
      }
      await delay(2_000, undefined, { signal: stop.signal }).catch(() => {});
    }
  };
  void poll();
  let sending = false;
  const dispatcher = setInterval(() => {
    if (sending) return;
    const item = store.leaseWeixinNotice(owner, channel, Date.now(), [...config.senders]);
    if (!item) return;
    sending = true;
    void transport.send(item.chat, item.context, item.id, item.text, stop.signal)
      .then(() => { if (!stop.signal.aborted) store.finishChannelNotice(item.id, true); })
      .catch(() => { if (!stop.signal.aborted) console.error('Weixin notification outcome is unknown'); })
      .finally(() => { sending = false; });
  }, 1_000);
  dispatcher.unref();
  return {
    health: () => health,
    stop() { clearInterval(dispatcher); stop.abort(); },
  };
}
