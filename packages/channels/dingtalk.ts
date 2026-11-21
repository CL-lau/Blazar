import { readAttachmentText } from './attachments.ts';

export type DingTalkConfig = {
  robotCode: string;
  senders: ReadonlySet<string>;
  conversations: ReadonlySet<string>;
};

function authorizedDingTalkBody(raw: string, config: DingTalkConfig) {
  if (raw.length > 64_000) return undefined;
  let body: {
    robotCode?: unknown; msgtype?: unknown; text?: { content?: unknown };
    senderStaffId?: unknown; conversationId?: unknown; msgId?: unknown; conversationType?: unknown;
    content?: { downloadCode?: unknown; fileName?: unknown };
  };
  try { body = JSON.parse(raw); } catch { return undefined; }
  if (!body || body.robotCode !== config.robotCode ||
      typeof body.senderStaffId !== 'string' || !config.senders.has(body.senderStaffId) ||
      typeof body.conversationId !== 'string' || !config.conversations.has(body.conversationId) ||
      typeof body.msgId !== 'string' || !body.msgId || body.msgId.length > 256) return undefined;
  return { ...body, senderStaffId: body.senderStaffId, conversationId: body.conversationId, msgId: body.msgId };
}

export function parseDingTalk(raw: string, config: DingTalkConfig) {
  const body = authorizedDingTalkBody(raw, config);
  if (body?.msgtype !== 'text' || typeof body.text?.content !== 'string' || body.text.content.length > 32_000) return undefined;
  const text = body.text.content.trim();
  if (!text.startsWith('/blazar ')) return undefined;
  const command = text.slice('/blazar '.length).trim();
  if (!command) return undefined;
  const message = { id: body.msgId, chat: body.conversationId, thread: body.msgId, root: true, text: command, sender: body.senderStaffId, privateChat: body.conversationType === '1' };
  if (!command.startsWith('follow ')) return message;
  const follow = /^follow ([a-f0-9-]{36}) ([\s\S]+)$/.exec(command);
  if (!follow?.[2].trim()) return undefined;
  return { ...message, root: false, taskId: follow[1], text: follow[2].trim() };
}

export function parseDingTalkAttachment(raw: string, config: DingTalkConfig) {
  const body = authorizedDingTalkBody(raw, config);
  if (body?.msgtype !== 'file' || body.conversationType !== '1') return undefined;
  const code = body.content?.downloadCode;
  const name = body.content?.fileName;
  if (typeof code !== 'string' || !/^[a-zA-Z0-9_+\/=.-]{1,2048}$/.test(code) ||
      typeof name !== 'string' || !/\.(txt|md|csv|json|log)$/i.test(name) ||
      name.length > 128 || /[\x00-\x1f\x7f/\\]/.test(name)) return undefined;
  return { id: body.msgId, chat: body.conversationId, thread: body.msgId, sender: body.senderStaffId, code, name };
}

export function createDingTalkAttachmentReader(config: { clientId: string; clientSecret: string; robotCode: string },
                                               hosts: ReadonlySet<string>, transport = fetch) {
  let credential: { token: string; until: number } | undefined;
  return async (downloadCode: string) => {
    const signal = AbortSignal.timeout(5_000);
    async function post(path: string, body: object, token?: string) {
      const response = await transport('https://api.dingtalk.com/v1.0/' + path, {
        method: 'POST', redirect: 'error', signal, body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', ...(token && { 'x-acs-dingtalk-access-token': token }) },
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) credential = undefined;
        throw new Error('DingTalk attachment API failed');
      }
      return await response.json() as Record<string, unknown>;
    }
    if (!credential || credential.until <= Date.now()) {
      const response = await post('oauth2/accessToken', { appKey: config.clientId, appSecret: config.clientSecret });
      if (typeof response.accessToken !== 'string' || typeof response.expireIn !== 'number') {
        throw new Error('DingTalk did not return an access token');
      }
      credential = { token: response.accessToken, until: Date.now() + Math.max(0, response.expireIn - 60) * 1_000 };
    }
    const result = await post('robot/messageFiles/download', { downloadCode, robotCode: config.robotCode }, credential.token);
    if (typeof result.downloadUrl !== 'string' || result.downloadUrl.length > 4_096) return undefined;
    let url: URL;
    try { url = new URL(result.downloadUrl); } catch { return undefined; }
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !hosts.has(url.hostname)) return undefined;
    const response = await transport(url, { redirect: 'error', signal });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403 || response.status === 404) return undefined;
      throw new Error('DingTalk attachment download failed');
    }
    const text = await readAttachmentText(response);
    return text && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) && text.trim() ? text : undefined;
  };
}

export type ReplyWindow = { url: URL; expires: number };

export function dingTalkReplyWindow(raw: string, now: number): ReplyWindow | undefined {
  let body: { sessionWebhook?: unknown; sessionWebhookExpiredTime?: unknown };
  try { body = JSON.parse(raw); } catch { return undefined; }
  const address = body?.sessionWebhook;
  const expires = body?.sessionWebhookExpiredTime;
  if (typeof address !== 'string' || address.length > 2048 ||
      typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires <= now) return undefined;
  let url: URL;
  try { url = new URL(address); } catch { return undefined; }
  if (url.origin !== 'https://oapi.dingtalk.com' || url.pathname !== '/robot/sendBySession' ||
      url.username || url.password || url.hash || !url.searchParams.get('session')) return undefined;
  return { url, expires };
}

export async function sendDingTalkNotice(window: ReplyWindow, text: string, transport = fetch) {
  const response = await transport(window.url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('DingTalk reply failed');
  }
  const data = await response.json();
  if (!data || typeof data !== 'object' || !('errcode' in data) || data.errcode !== 0) throw new Error('DingTalk rejected the reply');
}
