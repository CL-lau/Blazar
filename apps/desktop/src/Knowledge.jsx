import React, { useEffect, useState } from 'react';
import { callRouter } from './router.js';

export function Knowledge({ token }) {
  const [connections, setConnections] = useState([]);
  const [results, setResults] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [answer, setAnswer] = useState(null);

  const request = (path, options) => callRouter(token, path, options);

  async function perform(action) {
    setError('');
    setNotice('');
    setAnswer(null);
    setBusy(true);
    try { await action(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    let current = true;
    callRouter(token, '/app-connections')
      .then(data => { if (current) setConnections(data.connections); })
      .catch(failure => { if (current) setError(failure.message); });
    return () => { current = false; };
  }, [token]);

  const active = connections.filter(connection => connection.active);
  const accountName = connection => `${connection.app} · ${connection.account}`;

  async function refreshConnections() {
    setConnections((await request('/app-connections')).connections);
  }

  function saveAccount(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const { app, account, workspace } = Object.fromEntries(new FormData(form));
    void perform(async () => {
      await request('/app-connections', { method: 'POST', body: { app, account, workspace: workspace.trim() || undefined } });
      form.reset();
      await refreshConnections();
    });
  }

  function saveMemory(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const { workspace, body, resource, revision } = Object.fromEntries(new FormData(form));
    const source = selected ? { connection: selected, resource, revision } : undefined;
    void perform(async () => {
      await request('/memory', { method: 'POST', body: { workspace, body, source } });
      form.reset();
      setSelected('');
      setResults(null);
    });
  }

  function search(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    if (event.nativeEvent.submitter?.value === 'ask') {
      const question = String(fields.get('question') ?? '').trim();
      if (!question) { setError('Enter a question for Blazar.'); return; }
      void perform(async () => {
        const response = await request('/memory/answer', { method: 'POST', body: {
          workspace: fields.get('workspace'), query: fields.get('q'),
          question, sources: fields.getAll('source'),
        } });
        setAnswer(response);
      });
      return;
    }
    const query = new URLSearchParams();
    for (const [name, value] of fields) {
      if (name !== 'question' && value) query.append(name, value);
    }
    query.set('state', event.nativeEvent.submitter?.value === 'disabled' ? 'disabled' : 'active');
    void perform(async () => {
      setResults((await request('/memory?' + query)).items);
      setSearchQuery(query.toString());
      setEditing(null);
    });
  }

  function revise(item, change) {
    void perform(async () => {
      await request('/memory/' + item.id, {
        method: 'PATCH', body: { expectedVersion: item.version, ...change },
      });
      setEditing(null);
      setResults((await request('/memory?' + searchQuery)).items);
      setNotice('Memory updated.');
    });
  }

  return (
    <section className="detail knowledge">
      <h2>Apps and memory</h2>
      {notice && <p role="status">{notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <fieldset disabled={busy}>
        <legend>Source accounts</legend>
        <form onSubmit={saveAccount}>
          <label>App<input name="app" required maxLength={128} /></label>
          <label>Account<input name="account" required maxLength={256} /></label>
          <label>Limit to workspace<input name="workspace" maxLength={128} /></label>
          <button>Register source account</button>
        </form>
        <ul>{connections.map(connection => (
          <li key={connection.id}>
            <span>{accountName(connection)}{connection.workspace && ` · ${connection.workspace}`}</span>
            {connection.active ? <button onClick={() => perform(async () => {
              await request('/app-connections/' + connection.id, { method: 'DELETE' });
              setResults(null);
              if (selected === connection.id) setSelected('');
              await refreshConnections();
            })}>Disconnect</button> : <small>Disconnected</small>}
          </li>
        ))}</ul>
      </fieldset>

      {active.some(item => item.canImportDocument) && (
        <fieldset disabled={busy}>
          <legend>Import document</legend>
          <form onSubmit={event => {
            event.preventDefault();
            const form = event.currentTarget;
            const { connection, workspace, document } = Object.fromEntries(new FormData(form));
            void perform(async () => {
              await request('/app-connections/' + connection + '/import-document', {
                method: 'POST', body: { workspace, document },
              });
              form.reset();
              setResults(null);
              setNotice('Document imported into memory.');
            });
          }}>
            <label>Source account<select name="connection" required>
              {active.filter(item => item.canImportDocument).map(item => (
                <option key={item.id} value={item.id}>{accountName(item)}</option>
              ))}
            </select></label>
            <label>Workspace<input name="workspace" required maxLength={128} /></label>
            <label>Document ID or repository path<input name="document" required maxLength={128} /></label>
            <button>Import into memory</button>
          </form>
        </fieldset>
      )}

      <fieldset disabled={busy}>
        <legend>Save memory</legend>
        <form onSubmit={saveMemory}>
          <label>Workspace<input name="workspace" required maxLength={128} /></label>
          <label>Memory<textarea name="body" required maxLength={16000} /></label>
          <label>Source<select value={selected} onChange={event => setSelected(event.target.value)}>
            <option value="">Personal note</option>
            {active.map(connection => <option key={connection.id} value={connection.id}>{accountName(connection)}</option>)}
          </select></label>
          {selected && <>
            <label>Resource ID<input name="resource" required maxLength={512} /></label>
            <label>Revision<input name="revision" required maxLength={256} /></label>
          </>}
          <button>Save memory</button>
        </form>
      </fieldset>

      <fieldset disabled={busy}>
        <legend>Search memory</legend>
        <form onSubmit={search}>
          <label>Workspace<input name="workspace" required maxLength={128} /></label>
          <label>Search terms<input name="q" required maxLength={256} /></label>
          <label>Source accounts<select name="source" multiple disabled={!active.length}>
            {active.map(connection => <option key={connection.id} value={connection.id}>{accountName(connection)}</option>)}
          </select></label>
          <label>Question for Blazar<textarea name="question" maxLength={4000} /></label>
          <button>Search memory</button>
          <button type="submit" value="disabled">Find disabled memory</button>
          <button type="submit" value="ask">Ask Blazar with selected sources</button>
          <small>Asking Blazar sends matching excerpts to the configured model.</small>
        </form>
        {answer && <section aria-label="Answer from memory">
          <p>{answer.answer ?? 'No matching memories.'}</p>
          <ul>{answer.sources.map(source => {
            const account = connections.find(item => item.id === source.connection);
            return <li key={source.id}>{account ? accountName(account) + ' · ' + source.resource : 'Personal note'}</li>;
          })}</ul>
        </section>}
        {results?.length === 0 && <p role="status">No matching memories.</p>}
        {results?.length > 0 && <ul>{results.map(item => {
          const source = connections.find(connection => connection.id === item.connection);
          return <li key={item.id}>
            <p>{item.body}</p>
            <small>{source ? `${accountName(source)} · ${item.resource} · ${item.revision}` : 'Personal note'}</small>
            {editing === item.id ? <form onSubmit={event => {
              event.preventDefault();
              const body = new FormData(event.currentTarget).get('body');
              revise(item, { body });
            }}>
              <label>Corrected memory<textarea name="body" defaultValue={item.body} required maxLength={16000} /></label>
              <button>Save correction</button>
              <button type="button" onClick={() => setEditing(null)}>Cancel</button>
            </form> : <button onClick={() => setEditing(item.id)}>Edit memory</button>}
            {source && <button onClick={() => {
              if (!window.confirm('Revoke this source and delete its imported memories across all workspaces?')) return;
              void perform(async () => {
                await request('/app-connections/' + source.id + '/revoke-resource', {
                  method: 'POST', body: { resource: item.resource },
                });
                setResults(current => current?.filter(result => result.connection !== source.id || result.resource !== item.resource));
                setEditing(null);
                setNotice('Source access revoked.');
              });
            }}>Revoke source document</button>}
            <button onClick={() => revise(item, { disabled: !item.disabled })}>
              {item.disabled ? 'Restore to search' : 'Disable memory'}
            </button>
            <button onClick={() => revise(item, { pinned: !item.pinned })}>
              {item.pinned ? 'Unpin memory' : 'Pin memory'}
            </button>
            <button onClick={() => perform(async () => {
              await request('/memory/' + item.id, { method: 'DELETE' });
              setResults(current => current?.filter(result => result.id !== item.id));
            })}>Delete memory</button>
          </li>;
        })}</ul>}
      </fieldset>
    </section>
  );
}
