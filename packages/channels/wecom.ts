export type WeComConfig = {
  botId: string;
  secret: string;
  workspace: string;
  senders: ReadonlySet<string>;
  chats: ReadonlySet<string>;
};

export function parseWeCom(input: unknown, config: WeComConfig) {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as {
    aibotid?: unknown; msgid?: unknown; msgtype?: unknown; chattype?: unknown; chatid?: unknown;
    from?: { userid?: unknown }; text?: { content?: unknown };
  };
  const sender = value.from?.userid;
  if (value.aibotid !== config.botId || value.msgtype !== 'text' ||
      typeof sender !== 'string' || !config.senders.has(sender) ||
      typeof value.msgid !== 'string' || !value.msgid || value.msgid.length > 256 ||
      typeof value.text?.content !== 'string' || value.text.content.length > 32_000) return undefined;
  const chat = value.chattype === 'single' ? 'single:' + sender :
    value.chattype === 'group' && typeof value.chatid === 'string' ? 'group:' + value.chatid : '';
  if (!config.chats.has(chat)) return undefined;
  const command = value.text.content.trim();
  if (!command.startsWith('/blazar ')) return undefined;
  const text = command.slice('/blazar '.length).trim();
  if (!text) return undefined;
  const message = { id: value.msgid, chat, thread: value.msgid, root: true, text };
  if (!text.startsWith('follow ')) return message;
  const follow = /^follow ([a-f0-9-]{36}) ([\s\S]+)$/.exec(text);
  if (!follow?.[2].trim()) return undefined;
  return { ...message, root: false, taskId: follow[1], text: follow[2].trim() };
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
  return { botId, secret, workspace, senders, chats };
}
