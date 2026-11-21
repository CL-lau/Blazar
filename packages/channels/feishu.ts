import { timingSafeEqual } from 'node:crypto';

export type FeishuConfig = {
  token: string;
  appId: string;
  tenant: string;
  senders: ReadonlySet<string>;
  chats: ReadonlySet<string>;
  workspace: string;
};

type EventRecord = Record<string, unknown>;
type Message = {
  kind: 'message';
  id: string;
  chat: string;
  thread: string;
  root: boolean;
  text: string;
};

function object(input: unknown): EventRecord | undefined {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as EventRecord : undefined;
}

function matches(secret: string, candidate: unknown) {
  if (typeof candidate !== 'string') return false;
  const expected = Buffer.from(secret);
  const supplied = Buffer.from(candidate);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function parseFeishu(body: EventRecord, config: FeishuConfig):
  Message | { kind: 'attachment'; id: string; chat: string; thread: string; key: string; name: string } | { kind: 'challenge'; value: string } | { kind: 'ignore' } | { kind: 'unauthorized' } {
  if (body.type === 'url_verification') {
    if (!matches(config.token, body.token)) return { kind: 'unauthorized' };
    if (typeof body.challenge !== 'string' || body.challenge.length > 1024) return { kind: 'ignore' };
    return { kind: 'challenge', value: body.challenge };
  }
  const header = object(body.header);
  if (!header || !matches(config.token, header.token) ||
      header.app_id !== config.appId || header.tenant_key !== config.tenant) {
    return { kind: 'unauthorized' };
  }
  if (header.event_type !== 'im.message.receive_v1') return { kind: 'ignore' };
  const event = object(body.event);
  const sender = object(event?.sender);
  const senderId = object(sender?.sender_id)?.open_id;
  const message = object(event?.message);
  const chat = message?.chat_id;
  const id = message?.message_id;
  const rootId = message?.root_id;
  if (!sender || sender.sender_type !== 'user' || typeof senderId !== 'string' ||
      !config.senders.has(senderId) || typeof chat !== 'string' || !config.chats.has(chat) ||
      typeof id !== 'string' || !id || id.length > 256) return { kind: 'ignore' };
  const root = typeof rootId !== 'string' || !rootId;
  if (!root && rootId.length > 256) return { kind: 'ignore' };
  if (typeof message?.content !== 'string') return { kind: 'ignore' };
  let contents;
  try { contents = object(JSON.parse(message.content)); } catch { return { kind: 'ignore' }; }
  if (message.message_type === 'file' && !root) {
    const key = contents?.file_key;
    const name = contents?.file_name;
    if (typeof key === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(key) && typeof name === 'string' &&
        name.length <= 128 && !/[\x00-\x1f\x7f/\\]/.test(name) && /\.(txt|md|csv|json|log)$/i.test(name)) {
      return { kind: 'attachment', id, chat, thread: rootId, key, name };
    }
  }
  const value = contents?.text;
  if (message.message_type !== 'text' || typeof value !== 'string' || value.length > 32_000) return { kind: 'ignore' };
  const text = value.trim();
  if (!text.startsWith('/blazar ')) return { kind: 'ignore' };
  const goal = text.slice('/blazar '.length).trim();
  if (!goal) return { kind: 'ignore' };
  return { kind: 'message', id, chat, thread: root ? id : rootId, root, text: goal };
}

export function feishuChannel(config: FeishuConfig): string {
  return JSON.stringify(['feishu', config.tenant, config.appId]);
}

export function createFeishuSender(appId: string, appSecret: string, region: 'feishu' | 'lark', transport = fetch) {
  const base = region === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  let access: { token: string; expires: number } | undefined;
  async function post(path: string, body: object, token?: string) {
    const response = await transport(base + path, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Feishu request failed');
    }
    const data = object(await response.json());
    if (data?.code !== 0) {
      access = undefined;
      throw new Error('Feishu rejected the request');
    }
    return data;
  }

  async function token() {
    if (!access || access.expires <= Date.now()) {
      const data = await post('/open-apis/auth/v3/tenant_access_token/internal', { app_id: appId, app_secret: appSecret });
      if (typeof data.tenant_access_token !== 'string' || typeof data.expire !== 'number') {
        throw new Error('Feishu did not return a token');
      }
      access = { token: data.tenant_access_token, expires: Date.now() + Math.max(0, data.expire - 60) * 1_000 };
    }
    return access.token;
  }

  async function send(messageId: string, text: string, uuid: string) {
    await post('/open-apis/im/v1/messages/' + encodeURIComponent(messageId) + '/reply', {
      msg_type: 'text', content: JSON.stringify({ text }), uuid, reply_in_thread: true,
    }, await token());
  }

  async function readAttachment(messageId: string, key: string) {
    const response = await transport(base + '/open-apis/im/v1/messages/' + encodeURIComponent(messageId) +
      '/resources/' + encodeURIComponent(key) + '?type=file', {
      redirect: 'error', headers: { Authorization: 'Bearer ' + await token() }, signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403 || response.status === 404) return undefined;
      throw new Error('Feishu attachment request failed');
    }
    if (!response.body) return undefined;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 8_192) return undefined;
        chunks.push(chunk.value);
      }
      try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
      catch { return undefined; }
    } finally {
      await reader.cancel();
    }
  }

  return Object.assign(send, { readAttachment });
}
