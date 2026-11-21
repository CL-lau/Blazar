import React, { useEffect, useState } from 'react';
import { callRouter } from './router.js';

export function Knowledge({ token }) {
  const [connections, setConnections] = useState([]);
  const [definitions, setDefinitions] = useState([]);
  const [appName, setAppName] = useState('');
  const [documentSync, setDocumentSync] = useState([]);
  const [results, setResults] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState('');
  const [importAccount, setImportAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [answer, setAnswer] = useState(null);
  const [usage, setUsage] = useState(null);
  const [history, setHistory] = useState(null);

  const request = (path, options) => callRouter(token, path, options);

  async function perform(action) {
    setError('');
    setNotice('');
    setAnswer(null);
    setHistory(null);
    setBusy(true);
    try { await action(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    let current = true;
    callRouter(token, '/app-connections')
      .then(data => {
        if (!current) return;
        setConnections(data.connections);
        setDefinitions(data.definitions ?? []);
        setDocumentSync(data.documentSync ?? []);
      })
      .catch(failure => { if (current) setError(failure.message); });
    return () => { current = false; };
  }, [token]);

  const active = connections.filter(connection => connection.active);
  const importAccounts = active.filter(connection => connection.canImportDocument);
  const importSource = importAccounts.find(connection => connection.id === importAccount) ?? importAccounts[0];
  const accountName = connection => `${connection.app} · ${connection.account}`;

  async function refreshConnections() {
    const data = await request('/app-connections');
    setConnections(data.connections);
    setDefinitions(data.definitions ?? []);
    setDocumentSync(data.documentSync ?? []);
  }

  function saveAccount(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const { app, account, workspace } = Object.fromEntries(new FormData(form));
    void perform(async () => {
      await request('/app-connections', { method: 'POST', body: { app, account, workspace: workspace.trim() || undefined } });
      form.reset();
      setAppName('');
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

  function changeWorkspace(event, connection) {
    event.preventDefault();
    const workspace = String(new FormData(event.currentTarget).get('workspace')).trim() || null;
    void perform(async () => {
      await request('/app-connections/' + connection.id, { method: 'PATCH', body: { workspace } });
      setResults(null);
      setEditing(null);
      await refreshConnections();
      setNotice('Workspace access updated.');
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
          <label>App<input name="app" required maxLength={128} list="blazar-app-definitions" value={appName}
            onChange={event => setAppName(event.target.value)} /></label>
          <datalist id="blazar-app-definitions">{definitions.map(app =>
            <option key={app.id} value={app.id}>{app.label}</option>)}</datalist>
          <label>Account<input name="account" required maxLength={256} list="blazar-app-accounts" /></label>
          <datalist id="blazar-app-accounts">{definitions.find(app => app.id === appName)?.accounts.map(account =>
            <option key={account} value={account} />)}</datalist>
          <label>Limit to workspace<input name="workspace" maxLength={128} /></label>
          <button>Register source account</button>
        </form>
        <ul>{connections.map(connection => (
          <li key={connection.id}>
            <span>{accountName(connection)}{connection.workspace && ` · ${connection.workspace}`}</span>
            {connection.capabilities?.length > 0 && <ul aria-label="Connection capabilities">
              {connection.capabilities.map(capability => <li key={capability.id}>
                {capability.label} · {{ configured: 'Configured', configuration_required: 'Configuration required',
                  disconnected: 'Disconnected' }[capability.state]}
              </li>)}
            </ul>}
            {connection.lastDocumentTest && <small>
              Last document test · {({
                succeeded: 'Passed', access_denied: 'Access denied', failed: 'Failed', access_changed: 'Access changed',
              })[connection.lastDocumentTest.status] ?? connection.lastDocumentTest.status}
              {' · '}{connection.lastDocumentTest.workspace}
              {' · '}{new Date(connection.lastDocumentTest.started).toLocaleString()}
            </small>}
            {connection.active && <form onSubmit={event => changeWorkspace(event, connection)}>
              <label>Limit to workspace<input name="workspace" defaultValue={connection.workspace ?? ''} maxLength={128} /></label>
              <button>Save scope</button>
            </form>}
            {connection.active ? <button onClick={() => perform(async () => {
              await request('/app-connections/' + connection.id, { method: 'DELETE' });
              setResults(null);
              if (selected === connection.id) setSelected('');
              await refreshConnections();
            })}>Disconnect</button> : <small>Disconnected</small>}
            <button type="button" onClick={() => perform(async () => {
              const data = await request('/app-connections/' + connection.id + '/usage');
              setUsage({ account: accountName(connection), items: data.usage });
            })}>View usage</button>
          </li>
        ))}</ul>
        {usage && <section aria-label="Application connection usage">
          <h3>{usage.account}</h3>
          {usage.items.length === 0 ? <p>No connection activity yet.</p> : <ul>{usage.items.map(item => (
            <li key={item.id}>
              {{ import: 'Document import', test: 'Access test', refresh: 'Document refresh', worker_memory: 'Worker memory access' }[item.operation]} · {item.workspace} ·{' '}
              {item.taskId && <><code>{item.taskId}</code> · </>}
              {item.status.replaceAll('_', ' ')} · {new Date(item.started).toLocaleString()}
            </li>
          ))}</ul>}
        </section>}
      </fieldset>

      {importSource && (
        <fieldset disabled={busy}>
          <legend>Import document</legend>
          <form onSubmit={event => {
            event.preventDefault();
            const form = event.currentTarget;
            const { connection, workspace, document } = Object.fromEntries(new FormData(form));
            const testAccess = event.nativeEvent.submitter?.value === 'test';
            void perform(async () => {
              setUsage(null);
              try {
                await request('/app-connections/' + connection + (testAccess ? '/test-document' : '/import-document'), {
                  method: 'POST', body: { workspace, document },
                });
              } finally {
                if (testAccess) await refreshConnections().catch(() => {});
              }
              if (testAccess) {
                setNotice('Document access verified.');
                return;
              }
              form.reset();
              setResults(null);
              setNotice('Document imported into memory.');
            });
          }}>
            <label>Source account<select name="connection" value={importSource.id}
              onChange={event => setImportAccount(event.target.value)} required>
              {importAccounts.map(item => (
                <option key={item.id} value={item.id}>{accountName(item)}</option>
              ))}
            </select></label>
            <label>Workspace<input name="workspace" key={importSource.id + (importSource.workspace ?? '')}
              defaultValue={importSource.workspace ?? ''} readOnly={Boolean(importSource.workspace)} required maxLength={128} /></label>
            {importSource.documentAliases ? <label>Document<select name="document" key={importSource.id} required>
              <option value="">Choose a document</option>
              {importSource.documentAliases.map(alias => <option key={alias} value={alias}>{alias}</option>)}
            </select></label> : <label>Document ID or repository path<input name="document" required maxLength={128} /></label>}
            <button>Import into memory</button>
            <button type="submit" value="test">Test document access</button>
            <button type="button" onClick={event => {
              const form = event.currentTarget.form;
              const field = form.elements.namedItem('workspace');
              if (!field.reportValidity()) return;
              const { connection, workspace } = Object.fromEntries(new FormData(form));
              void perform(async () => {
                let after;
                let refreshed = 0;
                let unavailable = 0;
                do {
                  const page = await request('/app-connections/' + connection + '/refresh-documents', {
                    method: 'POST', body: { workspace, ...(after && { after }) },
                  });
                  refreshed += page.refreshed;
                  unavailable += page.unavailable;
                  after = page.after;
                } while (after);
                setUsage(null);
                setResults(null);
                setNotice(`Refreshed ${refreshed} documents. Could not refresh ${unavailable}.`);
              });
            }}>Refresh imported documents</button>
            <label>Automatic refresh<select name="interval">
              <option value="">Off</option>
              <option value="15">Every 15 minutes</option>
              <option value="60">Every hour</option>
              <option value="360">Every six hours</option>
              <option value="1440">Every day</option>
            </select></label>
            <button type="button" onClick={event => {
              const form = event.currentTarget.form;
              if (!form.elements.namedItem('workspace').reportValidity()) return;
              const { connection, workspace, interval } = Object.fromEntries(new FormData(form));
              void perform(async () => {
                await request('/app-connections/' + connection + '/document-sync', {
                  method: 'POST', body: { workspace, intervalMinutes: interval ? Number(interval) : null },
                });
                await refreshConnections();
                setNotice('Automatic refresh settings saved.');
              });
            }}>Save refresh schedule</button>
          </form>
          {documentSync.filter(schedule => schedule.connection === importSource.id).map(schedule => (
            <p key={schedule.workspace}>{schedule.workspace} · Every {schedule.intervalMinutes} minutes</p>
          ))}
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
            <small>{source ? `${accountName(source)} · ${item.resource} · ${item.revision}` :
              item.taskId ? `Task ${item.taskId} · version ${item.taskVersion}` : 'Personal note'}</small>
            {editing === item.id ? <form onSubmit={event => {
              event.preventDefault();
              const body = new FormData(event.currentTarget).get('body');
              revise(item, { body });
            }}>
              <label>Corrected memory<textarea name="body" defaultValue={item.body} required maxLength={16000} /></label>
              <button>Save correction</button>
              <button type="button" onClick={() => setEditing(null)}>Cancel</button>
            </form> : <button onClick={() => setEditing(item.id)}>Edit memory</button>}
            <button type="button" onClick={() => perform(async () => {
              setHistory(await request('/memory/' + item.id + '/history'));
            })}>View version history</button>
            {history?.item.id === item.id && <section aria-label="Memory version history">
              <h3>Version history</h3>
              <p>Current memory version {history.item.version}</p>
              {history.edits.length > 0 && <ul>{history.edits.map(edit => <li key={edit.version}>
                Version {edit.version} replaced {new Date(edit.replacedAt).toLocaleString()}
              </li>)}</ul>}
              {history.sourceRevisions.length > 0 && <ul aria-label="Source revisions">{history.sourceRevisions.map(revision =>
                <li key={revision.id}><code>{revision.revision}</code> · {new Date(revision.created).toLocaleString()}
                  {revision.current ? ' · Current source' : ''}
                </li>)}</ul>}
            </section>}
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
