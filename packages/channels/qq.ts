import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export type QQConfig = {
  appId: string;
  secret: string;
  senders: ReadonlySet<string>;
  chats: ReadonlySet<string>;
  workspace: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function createQQHandler(config: QQConfig) {
  if (!config.secret) throw new Error('QQ bot secret is required');
  const seed = Buffer.from(config.secret.repeat(32)).subarray(0, 32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der', type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  return (body: Record<string, unknown>, raw: Buffer, timestamp: unknown, signature: unknown, now: number) => {
    const event = record(body.d);
    if (body.op === 13) {
      const token = event?.plain_token;
      const time = event?.event_ts;
      if (typeof time !== 'string' || !/^\d{10,13}$/.test(time) ||
          typeof token !== 'string' || !/^[A-Za-z0-9_+\/=.-]{1,512}$/.test(token)) {
        return { kind: 'unauthorized' } as const;
      }
      const signed = sign(null, Buffer.from(time + token), privateKey).toString('hex');
      return { kind: 'challenge', plain_token: token, signature: signed } as const;
    }
    if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) ||
        Math.abs(now - Number(timestamp) * 1_000) > 300_000 ||
        typeof signature !== 'string' || !/^[a-fA-F0-9]{128}$/.test(signature) ||
        !verify(null, Buffer.concat([Buffer.from(timestamp), raw]), publicKey, Buffer.from(signature, 'hex'))) {
      return { kind: 'unauthorized' } as const;
    }
    if (body.op !== 0 || !event) return { kind: 'ignore' } as const;
    const author = record(event.author);
    let sender: unknown;
    let chat: string;
    if (body.t === 'C2C_MESSAGE_CREATE' && typeof author?.user_openid === 'string') {
      sender = author.user_openid;
      chat = 'c2c:' + sender;
    } else if (body.t === 'GROUP_AT_MESSAGE_CREATE' && typeof event.group_openid === 'string') {
      sender = author?.member_openid;
      chat = 'group:' + event.group_openid;
    } else return { kind: 'ignore' } as const;
    if (typeof sender !== 'string' || !config.senders.has(sender) || !config.chats.has(chat) ||
        typeof event.id !== 'string' || !event.id || event.id.length > 256 ||
        typeof event.content !== 'string' || event.content.length > 32_000) return { kind: 'ignore' } as const;
    const command = event.content.trim();
    if (!command.startsWith('/blazar ')) return { kind: 'ignore' } as const;
    const text = command.slice('/blazar '.length).trim();
    if (!text) return { kind: 'ignore' } as const;
    const eventTime = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
    const sent = Math.min(Number(timestamp) * 1_000, Number.isFinite(eventTime) ? eventTime : now);
    const replyExpires = sent + (chat.startsWith('group:') ? 5 : 60) * 60_000;
    const message = { id: event.id, chat, thread: event.id, root: true, text, replyExpires };
    if (!text.startsWith('follow ')) return { kind: 'message', message } as const;
    const follow = /^follow ([a-f0-9-]{36}) ([\s\S]+)$/.exec(text);
    if (!follow?.[2].trim()) return { kind: 'ignore' } as const;
    return { kind: 'message', message: { ...message, root: false, taskId: follow[1], text: follow[2].trim() } } as const;
  };
}

export function qqChannel(config: QQConfig) {
  return JSON.stringify(['qq', config.appId]);
}

export function createQQSender(config: QQConfig, transport = fetch) {
  let access: { token: string; expires: number } | undefined;
  async function post(url: string, payload: object, token?: string) {
    const response = await transport(url, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `QQBot ${token}` } : {}) },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) access = undefined;
      throw new Error('QQ request was rejected');
    }
    return response.json();
  }
  return async (notice: { chat: string; messageId: string; text: string; seq: number; expires: number }) => {
    if (!config.chats.has(notice.chat)) throw new Error('QQ destination unavailable');
    const expires = notice.expires;
    if (expires <= Date.now()) throw new Error('QQ reply window expired');
    const [type, openId, extra] = notice.chat.split(':');
    if (extra || !openId || (type !== 'group' && type !== 'c2c')) throw new Error('Invalid QQ destination');
    if (!access || access.expires <= Date.now()) {
      const data = await post('https://bots.qq.com/app/getAppAccessToken', {
        appId: config.appId, clientSecret: config.secret,
      });
      const ttl = Number(data?.expires_in);
      if (typeof data?.access_token !== 'string' || !data.access_token || !Number.isFinite(ttl) || ttl <= 0) {
        throw new Error('QQ did not return an access token');
      }
      access = { token: data.access_token, expires: Date.now() + Math.max(0, ttl - 60) * 1_000 };
    }
    if (expires <= Date.now()) throw new Error('QQ reply window expired');
    const scope = type === 'group' ? 'groups' : 'users';
    const data = await post(`https://api.sgroup.qq.com/v2/${scope}/${encodeURIComponent(openId)}/messages`, {
      msg_type: 0, msg_id: notice.messageId, msg_seq: notice.seq, content: notice.text,
    }, access.token);
    if (typeof data?.id !== 'string' || !data.id) throw new Error('QQ result is unknown');
  };
}
