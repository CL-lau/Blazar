import { useDesktopLanguage } from './DesktopLanguage.jsx';
import { PageHeading } from './PageHeading.jsx';
import React, { useEffect, useState } from 'react';
import { callRouter } from './router.js';

export function Wiki({ token, workspace, reviewId, scope }) {
  const { t } = useDesktopLanguage();
  const [pages, setPages] = useState([]);
  const [matches, setMatches] = useState([]);
  const [revision, setRevision] = useState(null);
  const [publishedRevision, setPublishedRevision] = useState(false);
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

  useEffect(() => {
    if (!reviewId) return;
    const stop = new AbortController();
    callRouter(token, '/wiki/' + reviewId + '/revision', { signal: stop.signal }).then(data => {
      if (stop.signal.aborted || data.workspace !== workspace) return;
      setRevision(data);
      setTitle(data.title);
      const current = data.sources.filter(source => source.id);
      setMatches(current);
      setSelected(current.map(({ id, version }) => ({ id, version })));
    }).catch(failure => { if (!stop.signal.aborted) setError(failure.message); });
    return () => stop.abort();
  }, [token, workspace, reviewId]);

  async function perform(operation) {
    setBusy(true);
    setError('');
    try { await operation(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  const evidence = { workspace, title: title.trim(), sources: selected };
  const ready = evidence.title && selected.length > 0;
  return <section className="detail wiki-page">
    <PageHeading title={revision && !publishedRevision ? 'Revise Wiki page' : 'Wiki'}
      description={'Search published notes and draft pages from sources in ' + workspace + '.'} actions={scope} />
    {publishedRevision && <p role="status">Revised page published.</p>}
    {revision && !publishedRevision && <ul aria-label="Source review">{revision.sources.map((source, index) =>
      <li key={source.id ?? index}>{source.id ? <>{source.resource} · {source.revision} · {source.state}</>
        : 'A previous source is unavailable'}</li>)}</ul>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="page-split plan-layout">
    <section className="page-pane" aria-label="Published Wiki pages">
    <h2>{t('Published pages', '已发布页面')}</h2>
    <form onSubmit={event => { event.preventDefault(); void perform(reload); }}>
      <label>{t('Search published pages', '搜索已发布页面')}<input type="search" value={query} maxLength={256} onChange={event => setQuery(event.target.value)} /></label>
      <button disabled={busy}>{t('Search pages', '搜索页面')}</button>
    </form>
    {!pages.length && <p className="muted">No published pages match this workspace or search.</p>}
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
    </section>
    <section className="page-pane" aria-label="Wiki draft">
    <h2>{t('Draft a page', '起草页面')}</h2>
    <form onSubmit={event => {
      event.preventDefault();
      const q = String(new FormData(event.currentTarget).get('q')).trim();
      if (!q) return;
      void perform(async () => {
        const accounts = (await request('/app-connections')).connections.filter(account =>
          account.active && (!account.workspace || account.workspace === workspace));
        const parameters = new URLSearchParams({ workspace, q });
        for (const account of accounts.slice(0, 25)) parameters.append('source', account.id);
        const found = (await request('/memory?' + parameters)).items.filter(item => item.connection);
        setMatches(current => [...new Map([...current.filter(item => selected.some(source => source.id === item.id)),
          ...found].map(item => [item.id, item])).values()]);
      });
    }}>
      <h3>{t('Find sources for a new page', '为新页面查找来源')}</h3>
      <label>{t('Search memory', '搜索记忆')}<input name="q" required maxLength={256} disabled={busy} /></label>
      <button disabled={busy}>{t('Find sources', '查找来源')}</button>
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
    <label>{t('Page title', '页面标题')}<input value={title} maxLength={160} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
    <label>Markdown<textarea value={body} maxLength={16000} disabled={busy} onChange={event => setBody(event.target.value)} /></label>
    <button disabled={busy || !ready} onClick={() => perform(async () => {
      setBody((await request('/wiki/draft', { method: 'POST', body: evidence })).body);
    })}>{busy ? 'Working…' : 'Draft with Blazar'}</button>
    <button className="primary" disabled={busy || !ready || !body.trim()} onClick={() => perform(async () => {
      await request('/wiki', { method: 'POST', body: { ...evidence, body,
        ...(revision && !publishedRevision && { replaces: revision.id }) } });
      if (revision) setPublishedRevision(true);
      setMatches([]);
      setTitle('');
      setBody('');
      setSelected([]);
      await reload();
    })}>{revision && !publishedRevision ? 'Publish revision' : 'Publish page'}</button>
    </section>
    </div>
  </section>;
}
