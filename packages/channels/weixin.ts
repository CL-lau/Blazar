import { createDecipheriv, randomBytes } from 'node:crypto';
import { decodeAttachmentText, readAttachmentBytes } from './attachments.ts';

export type WeixinConfig = {
  botId: string;
  token: string;
  base: string;
  workspace: string;
  senders: ReadonlySet<string>;
};

function authorizedWeixinMessage(input: unknown, config: WeixinConfig) {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as {
    from_user_id?: unknown; group_id?: unknown; message_type?: unknown; message_id?: unknown;
    context_token?: unknown;
    item_list?: { type?: unknown; text_item?: { text?: unknown }; file_item?: {
      file_name?: unknown; len?: unknown; media?: { full_url?: unknown; encrypt_query_param?: unknown; aes_key?: unknown };
    } }[];
  };
  if (value.message_type !== 1 || value.group_id || typeof value.from_user_id !== 'string' ||
      !config.senders.has(value.from_user_id) || typeof value.message_id !== 'string' ||
      !value.message_id || value.message_id.length > 256 || !Array.isArray(value.item_list)) return undefined;
  return { items: value.item_list, id: value.message_id, sender: value.from_user_id,
    context: typeof value.context_token === 'string' && value.context_token.length <= 16_384 ? value.context_token : undefined };
}

export function parseWeixin(input: unknown, config: WeixinConfig) {
  const source = authorizedWeixinMessage(input, config);
  if (!source) return undefined;
  const content = source.items.find(item => item?.type === 1)?.text_item?.text;
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text.startsWith('/blazar ') || text.length > 32_000) return undefined;
  const goal = text.slice('/blazar '.length).trim();
  if (!goal) return undefined;
  const { id, sender, context } = source;
  const message = { id, chat: sender, thread: id, root: true, text: goal };
  if (!goal.startsWith('follow ')) return { message, context };
  const follow = /^follow ([a-f0-9-]{36}) ([\s\S]+)$/.exec(goal);
  if (!follow?.[2].trim()) return undefined;
  return { message: { ...message, root: false, taskId: follow[1], text: follow[2].trim() }, context };
}

const weixinMediaOrigin = 'https://novac2c.cdn.weixin.qq.com';

export function parseWeixinAttachment(input: unknown, config: WeixinConfig) {
  const source = authorizedWeixinMessage(input, config);
  if (!source) return undefined;
  const files = source.items.filter(item => item?.type === 4);
  if (files.length !== 1) return undefined;
  const file = files[0].file_item;
  if (!file) return undefined;
  const name = file.file_name;
  const encodedKey = file.media?.aes_key;
  if (typeof name !== 'string' || !/\.(txt|md|csv|json|log)$/i.test(name) ||
      name.length > 128 || /[\x00-\x1f\x7f/\\]/.test(name) ||
      typeof encodedKey !== 'string' || !/^[a-zA-Z0-9+/]{22,43}={0,2}$/.test(encodedKey)) return undefined;
  const decodedKey = Buffer.from(encodedKey, 'base64');
  const hex = decodedKey.toString('ascii');
  const key = decodedKey.length === 16 ? decodedKey :
    /^[a-fA-F0-9]{32}$/.test(hex) && decodedKey.every(byte => byte < 128) ? Buffer.from(hex, 'hex') : undefined;
  if (!key) return undefined;
  if (file.len !== undefined && (typeof file.len !== 'string' || !/^\d{1,8}$/.test(file.len) || Number(file.len) > 8_192)) {
    return undefined;
  }
  let url: URL | undefined;
  const fullUrl = file.media?.full_url;
  if (typeof fullUrl === 'string' && fullUrl.length <= 4_096) {
    const candidate = URL.canParse(fullUrl) ? new URL(fullUrl) : undefined;
    if (candidate?.origin === weixinMediaOrigin && candidate.pathname === '/c2c/download' &&
        !candidate.username && !candidate.password && !candidate.hash) url = candidate;
  }
  const query = file.media?.encrypt_query_param;
  if (!url && typeof query === 'string' && query.length > 0 && query.length <= 2_048) {
    url = new URL('/c2c/download', weixinMediaOrigin);
    url.searchParams.set('encrypted_query_param', query);
  }
  if (!url) return undefined;
  return { id: source.id, chat: source.sender, thread: source.id, sender: source.sender, name, url, key };
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
    const value = JSON.parse(await response.text(), (key: string, value: unknown, context?: { source?: string }) => {
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
    async downloadAttachment(file: { url: URL; key: Buffer }, signal: AbortSignal) {
      if (file.url.origin !== weixinMediaOrigin || file.url.pathname !== '/c2c/download' ||
          file.url.username || file.url.password || file.url.hash) return undefined;
      const response = await transport(file.url, {
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 403 || response.status === 404) return undefined;
        throw new Error('Weixin attachment download failed');
      }
      const bytes = await readAttachmentBytes(response, 8_208);
      if (!bytes) return undefined;
      let text;
      try {
        const decoder = createDecipheriv('aes-128-ecb', file.key, null);
        text = decodeAttachmentText(Buffer.concat([decoder.update(bytes), decoder.final()]));
      } catch { return undefined; }
      return text?.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) ? text : undefined;
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
