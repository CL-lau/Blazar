import React, { useEffect, useState } from 'react';
import { callRouter } from './router.js';

function channelName(channel) {
  try {
    const [provider] = JSON.parse(channel);
    return { feishu: 'Feishu / Lark', weixin: 'WeChat', wecom: 'WeCom', dingtalk: 'DingTalk', qq: 'QQ' }[provider] ?? channel;
  } catch {
    return channel;
  }
}

export function ChannelLinks({ taskId, token, cursor }) {
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState([]);
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const path = '/admin/tasks/' + taskId + '/links';
  const deliveryLabels = {
    sent: 'Receipt sent', failed: 'Receipt failed', unknown: 'Delivery unconfirmed',
    expired: 'Receipt expired', pending: 'Receipt pending',
  };

  useEffect(() => {
    if (!open) return;
    const stop = new AbortController();
    let timer;
    async function refresh() {
      try {
        const result = await callRouter(token, path, { signal: stop.signal });
        if (!stop.signal.aborted) setLinks(result.links);
      } catch (failure) {
        if (!stop.signal.aborted) setError(failure.message);
      } finally {
        if (!stop.signal.aborted) timer = setTimeout(refresh, 5000);
      }
    }
    void refresh();
    return () => { stop.abort(); clearTimeout(timer); };
  }, [open, path, token, cursor]);

  async function update(action) {
    setError('');
    setBusy(true);
    try { await action(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>IM conversations</summary>
    {error && <p role="alert">{error}</p>}
    <ul>{links.map(link => <li key={link.id}>
      <span>{channelName(link.channel)} · {link.chat} · {link.thread}</span>
      {link.delivery && <small>{deliveryLabels[link.delivery]}</small>}
      <button disabled={busy} onClick={() => {
        if (!window.confirm('Unlink this conversation from the task?')) return;
        void update(async () => {
          await callRouter(token, path + '/' + link.id, { method: 'DELETE' });
          setLinks(current => current.filter(item => item.id !== link.id));
        });
      }}>Unlink</button>
    </li>)}</ul>
    <button disabled={busy} onClick={() => update(async () => {
      setInvite(await callRouter(token, '/admin/task-links', { method: 'POST', body: { taskId } }));
    })}>Create one-time link command</button>
    {invite && <>
      <p>Send this command in an authorized conversation for this workspace.</p>
      <code>/blazar /link {invite.code}</code>
      <p>Expires at {new Date(invite.expires).toLocaleTimeString()}</p>
      <p>For channels that require a task ID, use <code>/blazar follow {taskId} your instruction</code>.</p>
    </>}
  </details>;
}
