import { setTimeout as delay } from 'node:timers/promises';
import { parseWeixin, weixinTransport, type WeixinConfig } from '../../packages/channels/weixin.ts';
import type { TaskStore } from './store.ts';

export function startWeixin(store: TaskStore, owner: string, config: WeixinConfig) {
  const stop = new AbortController();
  const channel = JSON.stringify(['weixin', config.botId]);
  const transport = weixinTransport(config);
  const poll = async () => {
    while (!stop.signal.aborted) {
      try {
        const current = store.channelCursor(channel);
        const batch = await transport.poll(current, stop.signal);
        if (stop.signal.aborted) return;
        for (const raw of batch.messages) {
          const event = parseWeixin(raw, config);
          if (!event) continue;
          store.receiveChannelMessage(owner, channel, config.workspace, event.message, event.context);
        }
        if (batch.cursor !== current) store.saveChannelCursor(channel, batch.cursor);
        if (batch.messages.length) continue;
      } catch {
        if (!stop.signal.aborted) console.error('Weixin polling did not complete');
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
  return () => { clearInterval(dispatcher); stop.abort(); };
}
