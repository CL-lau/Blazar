export type DingTalkConfig = {
  robotCode: string;
  senders: ReadonlySet<string>;
  conversations: ReadonlySet<string>;
};

export function parseDingTalk(raw: string, config: DingTalkConfig) {
  if (raw.length > 64_000) return undefined;
  let body: {
    robotCode?: unknown; msgtype?: unknown; text?: { content?: unknown };
    senderStaffId?: unknown; conversationId?: unknown; msgId?: unknown;
  };
  try { body = JSON.parse(raw); } catch { return undefined; }
  if (!body || body.robotCode !== config.robotCode || body.msgtype !== 'text' ||
      typeof body.senderStaffId !== 'string' || !config.senders.has(body.senderStaffId) ||
      typeof body.conversationId !== 'string' || !config.conversations.has(body.conversationId) ||
      typeof body.msgId !== 'string' || !body.msgId || body.msgId.length > 256 ||
      typeof body.text?.content !== 'string' || body.text.content.length > 32_000) return undefined;
  const text = body.text.content.trim();
  if (!text.startsWith('/blazar ')) return undefined;
  const command = text.slice('/blazar '.length).trim();
  if (!command) return undefined;
  const message = { id: body.msgId, chat: body.conversationId, thread: body.msgId, root: true, text: command };
  if (!command.startsWith('follow ')) return message;
  const follow = /^follow ([a-f0-9-]{36}) ([\s\S]+)$/.exec(command);
  if (!follow?.[2].trim()) return undefined;
  return { ...message, root: false, taskId: follow[1], text: follow[2].trim() };
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
  if (data?.errcode !== 0) throw new Error('DingTalk rejected the reply');
}
