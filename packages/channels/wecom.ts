import { decryptFile } from '@wecom/aibot-node-sdk';
import { decodeAttachmentText, readAttachmentBytes } from './attachments.ts';

export type WeComConfig = {
  botId: string;
  secret: string;
  workspace: string;
  senders: ReadonlySet<string>;
  chats: ReadonlySet<string>;
  mediaHosts?: ReadonlySet<string>;
};

function authorizedWeComMessage(input: unknown, config: WeComConfig) {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as {
    aibotid?: unknown; msgid?: unknown; msgtype?: unknown; chattype?: unknown; chatid?: unknown;
    from?: { userid?: unknown }; text?: { content?: unknown }; file?: { url?: unknown; aeskey?: unknown };
  };
  const sender = value.from?.userid;
  if (value.aibotid !== config.botId || typeof sender !== 'string' || !config.senders.has(sender) ||
      typeof value.msgid !== 'string' || !value.msgid || value.msgid.length > 256) return undefined;
  const chat = value.chattype === 'single' ? 'single:' + sender :
    value.chattype === 'group' && typeof value.chatid === 'string' ? 'group:' + value.chatid : '';
  if (!config.chats.has(chat)) return undefined;
  return { value, id: value.msgid, chat, sender };
}

export function parseWeCom(input: unknown, config: WeComConfig) {
  const source = authorizedWeComMessage(input, config);
  if (!source || source.value.msgtype !== 'text') return undefined;
  const content = source.value.text?.content;
  if (typeof content !== 'string' || content.length > 32_000) return undefined;
  const { id, chat, sender } = source;
  const command = content.trim();
  if (!command.startsWith('/blazar ')) return undefined;
  const text = command.slice('/blazar '.length).trim();
  if (!text) return undefined;
  const message = { id, chat, thread: id, sender, root: true, text };
  if (!text.startsWith('follow ')) return message;
  const follow = /^follow ([a-f0-9-]{36}) ([\s\S]+)$/.exec(text);
  if (!follow?.[2].trim()) return undefined;
  return { ...message, root: false, taskId: follow[1], text: follow[2].trim() };
}

export function parseWeComAttachment(input: unknown, config: WeComConfig) {
  const source = authorizedWeComMessage(input, config);
  if (!source || source.value.msgtype !== 'file') return undefined;
  const { url, aeskey } = source.value.file ?? {};
  if (typeof url !== 'string' || url.length > 4_096 || typeof aeskey !== 'string' ||
      !/^[a-zA-Z0-9+/]{43}=?$/.test(aeskey)) return undefined;
  return { id: source.id, chat: source.chat, thread: source.id, sender: source.sender, url, aeskey };
}

export function createWeComAttachmentReader(hosts: ReadonlySet<string>, transport = fetch) {
  return async (raw: string, aeskey: string) => {
    let url: URL;
    try { url = new URL(raw); } catch { return undefined; }
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !hosts.has(url.hostname) ||
        !/(?:^|\.)qq\.com$/.test(url.hostname)) return undefined;
    const response = await transport(url, { redirect: 'error', signal: AbortSignal.timeout(3_000) });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403 || response.status === 404) return undefined;
      throw new Error('WeCom attachment download failed');
    }
    const bytes = await readAttachmentBytes(response, 8_224);
    if (!bytes) return undefined;
    const disposition = response.headers.get('content-disposition') ?? '';
    const encoded = /(?:^|;)\s*filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const plain = /(?:^|;)\s*filename=(?:"([^"]+)"|([^;]+))/i.exec(disposition);
    let name: string;
    let text: string | undefined;
    try {
      name = encoded ? decodeURIComponent(encoded.trim()) : (plain?.[1] ?? plain?.[2])?.trim() ?? '';
      text = decodeAttachmentText(decryptFile(bytes, aeskey));
    } catch { return undefined; }
    if (!/\.(txt|md|csv|json|log)$/i.test(name) || name.length > 128 || /[\x00-\x1f\x7f/\\]/.test(name) ||
        !text?.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return undefined;
    return { name, text };
  };
}

export function weComConfig(env: NodeJS.ProcessEnv): WeComConfig | undefined {
  const botId = env.BLAZAR_WECOM_BOT_ID;
  const secret = env.BLAZAR_WECOM_SECRET;
  if (!botId && !secret) return undefined;
  const workspace = env.BLAZAR_WECOM_WORKSPACE;
  const split = (value = '') => new Set(value.split(',').map(item => item.trim()).filter(Boolean));
  const senders = split(env.BLAZAR_WECOM_SENDERS);
  const chats = split(env.BLAZAR_WECOM_CHATS);
  if (!botId || !secret || !workspace || !senders.size || !chats.size ||
      [...chats].some(chat => !/^(single|group):[^\s]+$/.test(chat))) {
    throw new Error('Set all Blazar WeCom configuration values before enabling the bot');
  }
  return { botId, secret, workspace, senders, chats, mediaHosts: split(env.BLAZAR_WECOM_MEDIA_HOSTS?.toLowerCase()) };
}
