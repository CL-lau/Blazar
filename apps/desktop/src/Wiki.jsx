import React, { useEffect, useState } from 'react';
import { callRouter } from './router.js';

export function Wiki({ token, workspace }) {
  const [pages, setPages] = useState([]);
  const [matches, setMatches] = useState([]);
  const [selected, setSelected] = useState([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const request = (path, options) => callRouter(token, path, options);
  const reload = async () => setPages((await request('/wiki?' + new URLSearchParams({
    workspace, ...(query.trim() && { q: query.trim() }),
  }))).pages);
  useEffect(() => {
    const stop = new AbortController();
    callRouter(token, '/wiki?' + new URLSearchParams({ workspace }), { signal: stop.signal })
      .then(data => { if (!stop.signal.aborted) setPages(data.pages); })
      .catch(failure => { if (!stop.signal.aborted) setError(failure.message); });
    return () => stop.abort();
  }, [token, workspace]);

  async function perform(operation) {
    setBusy(true);
    setError('');
    try { await operation(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  const evidence = { workspace, title: title.trim(), sources: selected };
  const ready = evidence.title && selected.length > 0;
  return <section className="detail">
    <h2>Wiki</h2>
    {error && <p className="error" role="alert">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); void perform(reload); }}>
      <label>Search published pages<input type="search" value={query} maxLength={256} onChange={event => setQuery(event.target.value)} /></label>
      <button disabled={busy}>Search pages</button>
    </form>
    {pages.map(page =>
      <article className="workbench-entry" key={page.id}>
        <h3>{page.title}</h3>
        <pre>{page.body}</pre>
        <ul aria-label="Sources">{page.sources.map(source => <li key={source.id}>
          <strong>{source.resource}</strong> · <small>{source.revision}</small>
        </li>)}</ul>
        <button disabled={busy} onClick={() => perform(async () => {
          await request('/wiki/' + page.id + '/watch', { method: 'PUT', body: { enabled: !page.watched } });
          await reload();
        })}>{page.watched ? 'Stop watching' : 'Remind me when sources change'}</button>
      </article>)}
    <form onSubmit={event => {
      event.preventDefault();
      const q = String(new FormData(event.currentTarget).get('q')).trim();
      if (!q) return;
      void perform(async () => {
        const accounts = (await request('/app-connections')).connections.filter(account =>
          account.active && (!account.workspace || account.workspace === workspace));
        const parameters = new URLSearchParams({ workspace, q });
        for (const account of accounts.slice(0, 25)) parameters.append('source', account.id);
        setMatches((await request('/memory?' + parameters)).items.filter(item => item.connection));
        setSelected([]);
      });
    }}>
      <h3>Find sources for a new page</h3>
      <label>Search memory<input name="q" required maxLength={256} disabled={busy} /></label>
      <button disabled={busy}>Find sources</button>
    </form>
    {matches.map(item => <label className="checkbox-label" key={item.id}>
      <input type="checkbox" checked={selected.some(source => source.id === item.id)} disabled={busy ||
        (selected.length >= 6 && !selected.some(source => source.id === item.id))}
        onChange={event => {
          setSelected(event.target.checked ? [...selected, { id: item.id, version: item.version }]
            : selected.filter(source => source.id !== item.id));
        }} />
      {item.resource} · {item.revision}
    </label>)}
    <label>Page title<input value={title} maxLength={160} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
    <label>Markdown<textarea value={body} maxLength={16000} disabled={busy} onChange={event => setBody(event.target.value)} /></label>
    <button disabled={busy || !ready} onClick={() => perform(async () => {
      setBody((await request('/wiki/draft', { method: 'POST', body: evidence })).body);
    })}>{busy ? 'Working…' : 'Draft with Blazar'}</button>
    <button className="primary" disabled={busy || !ready || !body.trim()} onClick={() => perform(async () => {
      await request('/wiki', { method: 'POST', body: { ...evidence, body } });
      setTitle('');
      setBody('');
      setSelected([]);
      await reload();
    })}>Publish page</button>
  </section>;
}
