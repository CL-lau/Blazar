import { useDesktopLanguage } from './DesktopLanguage.jsx';
import { PageHeading } from './PageHeading.jsx';
import React, { useState } from 'react';
import { DesktopIcon } from './DesktopIcon.jsx';

const tools = [
  { id: 't3', name: 'T3 Code', detail: 'Coding sessions, repositories, worktrees and pull requests.',
    text: 'Opens the original workspace with its own T3 Code server.', fallback: import.meta.env.VITE_BLAZAR_T3_URL, port: 5733 },
  { id: 'linger', name: 'Linger', detail: 'Rooms, connected applications, documents and team work items.',
    text: 'Opens the original Linger interface with its own TeamHub server.', fallback: import.meta.env.VITE_BLAZAR_LINGER_URL, port: 3000 },
];

function localAddress(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password &&
      !url.search && !url.hash ? url.href : '';
  } catch { return ''; }
}

function ToolConnection({ tool }) {
  const { t } = useDesktopLanguage();
  const key = 'blazar.frontend.' + tool.id;
  const [address, setAddress] = useState(() => {
    try { return localAddress(localStorage.getItem(key) ?? tool.fallback); }
    catch { return localAddress(tool.fallback); }
  });
  const [draft, setDraft] = useState(address);
  const [message, setMessage] = useState('');
  const [invalid, setInvalid] = useState(false);

  function save(event) {
    event.preventDefault();
    const value = draft.trim();
    const validated = localAddress(value);
    if (value && !validated) {
      setInvalid(true);
      setMessage('Enter a local HTTP or HTTPS address without credentials or a query string.');
      return;
    }
    setInvalid(false);
    setAddress(validated);
    setDraft(validated);
    try {
      localStorage.setItem(key, validated);
      setMessage(validated ? 'Address saved.' : 'Address cleared.');
    } catch {
      setMessage('Address changed for this session. Local settings are unavailable.');
    }
  }

  return <article className="connected-tool">
    <div className="connected-tool-heading">
      <div><h2>{tool.name}</h2><p>{tool.detail}</p></div>
      {address && <a className="desktop-button primary" href={address} target="_blank" rel="noopener noreferrer">
        Open {tool.name}<DesktopIcon name="external" />
      </a>}
    </div>
    <p className="muted">{tool.text}</p>
    <span className="connection-state" data-ready={Boolean(address)}>{address ? 'Address saved' : 'Address required'}</span>
    <form onSubmit={save}>
      <label htmlFor={'tool-' + tool.id}>{t('Local frontend address', '本地前端地址')}</label>
      <div className="inline-control">
        <input id={'tool-' + tool.id} type="url" value={draft} aria-invalid={invalid || undefined}
          placeholder={'http://127.0.0.1:' + tool.port} onChange={event => { setDraft(event.target.value); setMessage(''); setInvalid(false); }} />
        <button>{t('Save address', '保存地址')}</button>
      </div>
      {message && <p className={invalid ? 'error' : 'muted'} role={invalid ? 'alert' : 'status'}>{message}</p>}
    </form>
  </article>;
}

export function ConnectedTools() {
  return <section className="detail connected-tools">
    <PageHeading title="Connected tools" description="Set the local addresses for your T3 Code and Linger workspaces." />
    <div className="tool-directory">{tools.map(tool => <ToolConnection key={tool.id} tool={tool} />)}</div>
  </section>;
}
