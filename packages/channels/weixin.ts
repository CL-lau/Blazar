import { randomBytes } from 'node:crypto';

export type WeixinConfig = {
  botId: string;
  token: string;
  base: string;
  workspace: string;
  senders: ReadonlySet<string>;
};

export function parseWeixin(input: unknown, config: WeixinConfig) {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as {
    from_user_id?: unknown; group_id?: unknown; message_type?: unknown; message_id?: unknown;
    context_token?: unknown; item_list?: { type?: unknown; text_item?: { text?: unknown } }[];
  };
  if (value.message_type !== 1 || value.group_id || typeof value.from_user_id !== 'string' ||
      !config.senders.has(value.from_user_id) || typeof value.message_id !== 'string' ||
      !value.message_id || value.message_id.length > 256 || !Array.isArray(value.item_list)) return undefined;
  const content = value.item_list.find(item => item?.type === 1)?.text_item?.text;
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text.startsWith('/blazar ') || text.length > 32_000) return undefined;
  const goal = text.slice('/blazar '.length).trim();
  if (!goal) return undefined;
  const context = typeof value.context_token === 'string' && value.context_token.length <= 16_384
    ? value.context_token : undefined;
  const message = {
    id: value.message_id, chat: value.from_user_id, thread: value.message_id, root: true, text: goal,
  };
  if (!goal.startsWith('follow ')) return { message, context };
  const follow = /^follow ([a-f0-9-]{36}) ([\s\S]+)$/.exec(goal);
  if (!follow?.[2].trim()) return undefined;
  return { message: { ...message, root: false, taskId: follow[1], text: follow[2].trim() }, context };
}

export function weixinConfig(env: NodeJS.ProcessEnv): WeixinConfig | undefined {
  const token = env.BLAZAR_WEIXIN_TOKEN;
  const botId = env.BLAZAR_WEIXIN_BOT_ID;
  if (!token && !botId) return undefined;
  const workspace = env.BLAZAR_WEIXIN_WORKSPACE;
  const senders = new Set((env.BLAZAR_WEIXIN_SENDERS ?? '').split(',').map(item => item.trim()).filter(Boolean));
  const base = new URL(env.BLAZAR_WEIXIN_BASE_URL ?? 'https://ilinkai.weixin.qq.com');
  if (base.protocol !== 'https:' || !/^ilinkai(?:-[a-z0-9]+)?\.weixin\.qq\.com$/.test(base.hostname) ||
      base.username || base.password || base.port || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Use a Weixin iLink endpoint returned by Tencent');
  }
  if (!token || !botId || !workspace || !senders.size) throw new Error('Incomplete Weixin configuration');
  return { token, botId, workspace, senders, base: base.origin };
}

export function weixinTransport(config: WeixinConfig, transport = fetch) {
  async function call(operation: 'getupdates' | 'sendmessage', body: object, signal: AbortSignal, timeout: number) {
    const response = await transport(`${config.base}/ilink/bot/${operation}`, {
      method: 'POST', redirect: 'error',
      headers: {
        'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
        Authorization: `Bearer ${config.token}`,
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
      },
      body: JSON.stringify({ ...body, base_info: { channel_version: '0.1.0', bot_agent: 'blazar' } }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Weixin request failed');
    }
    const value = JSON.parse(await response.text(), (key, value, context) => {
      if (key === 'message_id' && typeof value === 'number') return context?.source;
      return value;
    });
    if (!value || typeof value !== 'object' || value.ret || value.errcode) throw new Error('Weixin rejected the request');
    return value;
  }
  return {
    async poll(cursor: string, signal: AbortSignal) {
      const response = await call('getupdates', { get_updates_buf: cursor }, signal, 40_000);
      return {
        messages: (Array.isArray(response.msgs) ? response.msgs : []) as unknown[],
        cursor: typeof response.get_updates_buf === 'string' ? response.get_updates_buf : cursor,
      };
    },
    async send(chat: string, context: string, id: string, text: string, signal: AbortSignal) {
      if (!config.senders.has(chat) || !context) throw new Error('Weixin destination unavailable');
      await call('sendmessage', {
        msg: {
          from_user_id: '', to_user_id: chat, context_token: context, client_id: id,
          message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text } }],
        },
      }, signal, 12_000);
    },
  };
}
