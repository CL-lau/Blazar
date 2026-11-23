import { useDesktopLanguage } from './DesktopLanguage.jsx';
import { DesktopIcon } from './DesktopIcon.jsx';
import { PageHeading } from './PageHeading.jsx';
import { LingerCredit } from './LingerCredit.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { ApplicationCatalog, ApplicationMark } from './ApplicationCatalog.jsx';
import { ApplicationWrite } from './ApplicationWrite.jsx';
import { callRouter } from './router.js';
import './applications.css';

export function Knowledge({ token, initialPanel = 'applications' }) {
  const { t } = useDesktopLanguage();
  const [connections, setConnections] = useState([]);
  const [definitions, setDefinitions] = useState([]);
  const [appName, setAppName] = useState('');
  const [panel, setPanel] = useState(initialPanel);
  const [managedApp, setManagedApp] = useState(null);
  const [loadState, setLoadState] = useState('loading');
  const [documentSync, setDocumentSync] = useState([]);
  const [results, setResults] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [documentMatches, setDocumentMatches] = useState(null);
  const [documentPreview, setDocumentPreview] = useState(null);
  const [answerDocuments, setAnswerDocuments] = useState([]);
  const [refreshConflicts, setRefreshConflicts] = useState([]);
  const [discovered, setDiscovered] = useState(null);
  const [deriving, setDeriving] = useState(null);
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState('');
  const [importAccount, setImportAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [answer, setAnswer] = useState(null);
  const [usage, setUsage] = useState(null);
  const [history, setHistory] = useState(null);
  const managementOrigin = useRef(null);
  const managementHeading = useRef(null);

  useEffect(() => {
    if (managedApp !== null) managementHeading.current?.focus();
    else if (managementOrigin.current?.isConnected) {
      managementOrigin.current.focus();
      managementOrigin.current = null;
    }
  }, [managedApp]);

  const request = (path, options) => callRouter(token, path, options);

  async function perform(action) {
    setError('');
    setNotice('');
    setAnswer(null);
    setHistory(null);
    setDocumentMatches(null);
    setDocumentPreview(null);
    setRefreshConflicts([]);
    setDiscovered(null);
    setBusy(true);
    try { await action(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    setDocumentMatches(null);
    setDiscovered(null);
    let current = true;
    setLoadState('loading');
    callRouter(token, '/app-connections')
      .then(data => {
        if (!current) return;
        setConnections(data.connections);
        setDefinitions(data.definitions ?? []);
        setDocumentSync(data.documentSync ?? []);
        setLoadState('ready');
      })
      .catch(failure => {
        if (current) { setError(failure.message); setLoadState('failed'); }
      });
    return () => { current = false; };
  }, [token]);

  const active = connections.filter(connection => connection.active);
  const importAccounts = active.filter(connection => connection.canImportDocument);
  const importSource = importAccounts.find(connection => connection.id === importAccount) ?? importAccounts[0];
  const discovery = discovered?.connection === importSource?.id ? discovered : null;
  const documentAliases = discovery?.aliases ?? importSource?.documentAliases;
  const canDiscover = importSource?.capabilities?.some(capability =>
    capability.id === 'document.discover' && capability.state === 'configured');
  const appLabel = id => definitions.find(app => app.id === id)?.label ?? id;
  const accountName = connection => `${appLabel(connection.app)} · ${connection.account}`;
  const managing = managedApp !== null;
  const managedAccounts = connections.filter(connection => connection.app === managedApp);

  function manageApp(id, origin) {
    if (origin) managementOrigin.current = origin;
    setManagedApp(id);
    setAppName(id ?? '');
    setUsage(null);
    setError('');
    setNotice('');
  }

  async function refreshConnections() {
    const data = await request('/app-connections');
    setConnections(data.connections);
    setDefinitions(data.definitions ?? []);
    setDocumentSync(data.documentSync ?? []);
    setLoadState('ready');
  }

  function saveAccount(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const { app, account, workspace } = Object.fromEntries(new FormData(form));
    void perform(async () => {
      await request('/app-connections', { method: 'POST', body: { app, account, workspace: workspace.trim() || undefined } });
      form.reset();
      await refreshConnections();
      setManagedApp(app);
      setAppName(app);
      setNotice('Source account registered.');
    });
  }

  function saveMemory(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const { workspace, body, resource, revision, expires } = Object.fromEntries(new FormData(form));
    const source = selected ? { connection: selected, resource, revision } : undefined;
    void perform(async () => {
      await request('/memory', { method: 'POST', body: {
        workspace, body, source, ...(expires && { expires: new Date(expires).getTime() }),
      } });
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
    <section className="knowledge applications-page" aria-labelledby="applications-title">
      <PageHeading id="applications-title" title="Applications"
        description="Manage accounts, documents, and memory available to your workspaces."
        actions={panel === 'applications' && <button className="primary" type="button" onClick={event => manageApp('', event.currentTarget)}>{t('Add account', '添加账号')}</button>} />
      <nav className="apps-navigation" aria-label={t('Applications sections', '应用页面导航')}>
        {[['applications', 'Connected apps'], ['documents', 'Documents'], ['memory', 'Memory']].map(([id, label]) =>
          <button key={id} type="button" aria-current={panel === id ? 'page' : undefined}
            onClick={() => { setPanel(id); setError(''); setNotice(''); }}>{t(label)}</button>)}
      </nav>
      {notice && <p className="apps-notice" role="status">{notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="apps-layout" data-managing={managing} hidden={panel !== 'applications'}>
        <ApplicationCatalog definitions={definitions} connections={connections} selected={managedApp}
          select={manageApp} loading={loadState === 'loading'} failed={loadState === 'failed'}
          retry={() => perform(refreshConnections)} />
        {managing && <section className="apps-management" aria-labelledby="app-management-heading"
          onKeyDown={event => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault();
            const help = event.target.closest('.apps-scope-help[open]');
            if (help) help.open = false;
            else manageApp(null);
          }}>
          <div className="apps-management-heading">
            {managedApp && <ApplicationMark id={managedApp} label={appLabel(managedApp)} />}
            <h2 id="app-management-heading" tabIndex={-1} ref={managementHeading}>{managedApp ? appLabel(managedApp) : t('Add source account', '添加来源账号')}</h2>
            <button type="button" aria-label={t('Close account management', '关闭账号管理')} onClick={() => manageApp(null)}><DesktopIcon name="close" /></button>
          </div>
          {managedApp && <h3>Accounts <span>{managedAccounts.length}</span></h3>}
          {managedApp && managedAccounts.length === 0 && <p className="apps-empty">{t('No accounts registered.', '暂无已登记的账号。')}</p>}
          <ul className="apps-accounts">{managedAccounts.map(connection => (
          <li key={connection.id}>
            <details>
            <summary>
              <span className="apps-account-icon"><DesktopIcon name="account" /></span>
              <span className="apps-account-name"><strong>{connection.account}</strong>
                <small>{connection.workspace ?? t('All workspaces')}</small></span>
              <span className="component-status" data-tone={connection.active ? 'connected' : 'neutral'}>
                {connection.active ? t('Active', '有效') : t('Disconnected', '已断开')}
              </span>
              <DesktopIcon name="chevron" />
            </summary>
            <fieldset disabled={busy}>
            {connection.capabilities?.length > 0 && <ul className="apps-capabilities" aria-label="Connection capabilities">
              {connection.capabilities.map(capability => <li key={capability.id}>
                <span>{capability.label}</span>
                <span className="component-status" data-tone={{ configured: 'connected', configuration_required: 'attention' }[capability.state]}>
                  {t({ configured: 'Configured', configuration_required: 'Setup required',
                    disconnected: 'Disconnected' }[capability.state] ?? capability.state,
                  { configured: '已配置', configuration_required: '待配置', disconnected: '已断开' }[capability.state])}
                </span>
              </li>)}
            </ul>}
            {connection.lastDocumentTest && <small>
              Last document test · {({
                succeeded: 'Passed', access_denied: 'Access denied', failed: 'Failed', access_changed: 'Access changed',
              })[connection.lastDocumentTest.status] ?? connection.lastDocumentTest.status}
              {' · '}{connection.lastDocumentTest.workspace}
              {' · '}{new Date(connection.lastDocumentTest.started).toLocaleString()}
            </small>}
            {connection.lastHealthCheck && <small>
              Last connection check · {({
                succeeded: 'Passed', access_denied: 'Access denied', failed: 'Unavailable',
              })[connection.lastHealthCheck.status] ?? connection.lastHealthCheck.status}
              {' · '}{connection.lastHealthCheck.workspace}
              {' · '}{new Date(connection.lastHealthCheck.started).toLocaleString()}
            </small>}
            {connection.active && <form onSubmit={event => changeWorkspace(event, connection)}>
              <label>{t('Limit to workspace', '限定工作区')}<input name="workspace" defaultValue={connection.workspace ?? ''} maxLength={128} /></label>
              <button>{t('Save scope', '保存范围')}</button>
            </form>}
            {connection.active && connection.capabilities?.some(capability => capability.id === 'connection.health' &&
              capability.state === 'configured') && <form onSubmit={event => {
              event.preventDefault();
              const workspace = connection.workspace ?? new FormData(event.currentTarget).get('workspace');
              perform(async () => {
                const { status } = await request('/app-connections/' + connection.id + '/capabilities/connection.health', {
                  method: 'POST', body: { workspace },
                });
                await refreshConnections();
                setNotice({ succeeded: 'Connection check passed.', access_denied: 'Source access was denied.',
                  failed: 'Source could not be reached or returned an error.' }[status]);
              });
            }}>
              {!connection.workspace && <label>{t('Workspace', '工作区')}<input name="workspace" required maxLength={128} /></label>}
              <button>{t('Check connection', '检查连接')}</button>
            </form>}
            {(connection.writeCapabilities?.length > 0 || connection.hasWriteHistory) &&
              <ApplicationWrite key={token} connection={connection} request={request} />}
            <div className="apps-account-actions">
            {connection.active && <button className="apps-disconnect" type="button" onClick={() => {
              if (!window.confirm('Disconnect this source account?')) return;
              void perform(async () => {
                await request('/app-connections/' + connection.id, { method: 'DELETE' });
                setResults(null);
                if (selected === connection.id) setSelected('');
                await refreshConnections();
                setNotice('Source account disconnected.');
              });
            }}>{t('Disconnect', '断开连接')}</button>}
            <button type="button" onClick={() => perform(async () => {
              const data = await request('/app-connections/' + connection.id + '/usage');
              setUsage({ id: connection.id, account: accountName(connection), items: data.usage });
            })}>{t('View usage', '查看使用记录')}</button>
            {connection.canImportDocument && <button type="button" onClick={() => {
              setImportAccount(connection.id);
              setDocumentMatches(null);
              setDocumentPreview(null);
              setDiscovered(null);
              setPanel('documents');
            }}>{t('Open documents', '打开文档')}</button>}
            </div>
            </fieldset>
            </details>
          </li>
        ))}</ul>
          <details className="apps-register" key={managedApp} open={!managedAccounts.length}>
            <summary><DesktopIcon name="add" /> Register a source account <DesktopIcon name="chevron" /></summary>
          <fieldset disabled={busy}>
            <form key={managedApp} onSubmit={saveAccount}>
              {managedApp ? <input type="hidden" name="app" value={managedApp} /> :
                <label>{t('Application', '应用')}<input name="app" required maxLength={128} list="blazar-app-definitions" value={appName}
                  onChange={event => setAppName(event.target.value)} /></label>}
              <datalist id="blazar-app-definitions">{definitions.map(app =>
                <option key={app.id} value={app.id}>{app.label}</option>)}</datalist>
              <label>{t('Account', '账号')}<input name="account" required maxLength={256} list="blazar-app-accounts" /></label>
              <datalist id="blazar-app-accounts">{[...new Set(definitions.find(app => app.id === appName)?.accounts ?? [])].map(account =>
                <option key={account} value={account} />)}</datalist>
              <div className="apps-scope-field">
                <label>{t('Limit to workspace', '限定工作区')}<input name="workspace" maxLength={128} placeholder={t('All workspaces', '所有工作区')} /></label>
                <details className="apps-scope-help">
                  <summary aria-label={t('About workspace access', '关于工作区访问范围')}><DesktopIcon name="help" /></summary>
                  <p>{t('Enter a workspace name to restrict this account to that workspace. Leave the field blank to allow all workspaces.', '填写工作区名称后，此账号仅在该工作区可用。留空可用于所有工作区。')}</p>
                </details>
              </div>
              <button className="primary">{t('Register source account', '登记来源账号')}</button>
            </form>
          </fieldset>
          </details>
        {usage && <section aria-label="Application connection usage">
          <h3>{usage.account}</h3>
          <p>Connection ID <code>{usage.id}</code></p>
          {usage.items.length === 0 ? <p>No connection activity yet.</p> : <ul>{usage.items.map(item => (
            <li key={item.id}>
              {{ import: 'Document import', test: 'Access test', health: 'Connection check', read: 'Document preview', refresh: 'Document refresh', search: 'Document search', discover: 'Document discovery', worker_memory: 'Worker memory access' }[item.operation]} · {item.workspace} ·{' '}
              {item.taskId && <><code>{item.taskId}</code> · </>}
              {item.backend && <>{item.backend.kind === 'github' ? 'GitHub API' : 'MCP'}{item.backend.fallback && ' fallback'} · </>}
              {item.status.replaceAll('_', ' ')} · {new Date(item.started).toLocaleString()}
            </li>
          ))}</ul>}
        </section>}
        </section>}
      </div>

      <div className="apps-tools" hidden={panel !== 'documents'}>
      {!importSource && <p className="apps-empty">{t('Register an account with a configured document connector to use Documents.', '请先登记已配置文档连接器的账号。')}</p>}
      {importSource && (
        <fieldset disabled={busy}>
          <legend>{t('Documents', '文档')}</legend>
          <form onChange={() => {
            setDocumentPreview(null);
            setRefreshConflicts([]);
          }} onSubmit={event => {
            event.preventDefault();
            const form = event.currentTarget;
            const { connection, workspace, document } = Object.fromEntries(new FormData(form));
            const testAccess = event.nativeEvent.submitter?.value === 'test';
            const preview = event.nativeEvent.submitter?.value === 'preview';
            void perform(async () => {
              setUsage(null);
              if (preview) {
                const preview = await request('/app-connections/' + connection + '/capabilities/document.read', {
                  method: 'POST', body: { workspace, document },
                });
                setDocumentPreview({ ...preview, workspace });
                return;
              }
              try {
                await request('/app-connections/' + connection + (testAccess ? '/capabilities/document.test' : '/capabilities/document.import'), {
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
              onChange={event => {
                setImportAccount(event.target.value);
                setDocumentMatches(null);
                setDiscovered(null);
              }} required>
              {importAccounts.map(item => (
                <option key={item.id} value={item.id}>{accountName(item)}</option>
              ))}
            </select></label>
            <label>{t('Workspace', '工作区')}<input name="workspace" key={importSource.id + (importSource.workspace ?? '')}
              defaultValue={importSource.workspace ?? ''} readOnly={Boolean(importSource.workspace)}
              onChange={() => setDiscovered(null)} required maxLength={128} /></label>
            {canDiscover && <button type="button" onClick={event => {
              const form = event.currentTarget.form;
              if (!form.elements.namedItem('workspace').reportValidity()) return;
              const { connection, workspace } = Object.fromEntries(new FormData(form));
              void perform(async () => {
                const result = await request('/app-connections/' + connection + '/capabilities/document.discover', {
                  method: 'POST', body: { workspace },
                });
                setDiscovered({ connection, ...result });
              });
            }}>Check available documents</button>}
            {discovery && <p role="status">
              {discovery.aliases.length ? `${discovery.aliases.length} available documents` : 'No available documents found.'}
              {!discovery.complete && ' The server listing was only partially checked.'}
              {' '}<button type="button" onClick={() => setDiscovered(null)}>Show configured documents</button>
            </p>}
            {documentAliases ? <label>{t('Document', '文档')}<select name="document" key={importSource.id + (discovery ? '-discovered' : '')} required>
              <option value="">Choose a document</option>
              {documentAliases.map(alias => <option key={alias} value={alias}>{alias}</option>)}
            </select></label> : <label>Document ID or repository path<input name="document" required maxLength={128} /></label>}
            <button>{t('Import into memory', '导入记忆')}</button>
            <button type="submit" value="preview">Preview document</button>
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
                const conflicts = [];
                do {
                  const page = await request('/app-connections/' + connection + '/capabilities/document.refresh', {
                    method: 'POST', body: { workspace, ...(after && { after }) },
                  });
                  refreshed += page.refreshed;
                  unavailable += page.unavailable;
                  if (page.conflicts) conflicts.push(...page.conflicts);
                  after = page.after;
                } while (after);
                setUsage(null);
                setResults(null);
                setNotice(`Refreshed ${refreshed} documents. Could not refresh ${unavailable}.`);
                setRefreshConflicts(conflicts);
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
          {documentPreview && <section aria-label="Document preview">
            <h3>{documentPreview.resource}</h3>
            <p>Revision <code>{documentPreview.revision}</code></p>
            {documentPreview.backend && <p>
              {documentPreview.backend.kind === 'github' ? 'GitHub API' : 'MCP'}{documentPreview.backend.fallback && ' fallback'}
            </p>}
            <pre>{documentPreview.text}</pre>
            {documentPreview.truncated && <p>Preview truncated.</p>}
            <button type="button" disabled={answerDocuments.length >= 4 ||
              answerDocuments.some(item => item.workspace !== documentPreview.workspace ||
                (item.connection === documentPreview.connection && item.resource === documentPreview.resource))}
            onClick={() => setAnswerDocuments(documents => [...documents, {
              connection: documentPreview.connection, resource: documentPreview.resource,
              revision: documentPreview.revision, workspace: documentPreview.workspace,
            }])}>Select for answer</button>
          </section>}
          {answerDocuments.length > 0 && <form onSubmit={event => {
            event.preventDefault();
            const question = new FormData(event.currentTarget).get('question');
            void perform(async () => {
              const response = await request('/memory/answer', { method: 'POST', body: {
                workspace: answerDocuments[0].workspace, question,
                documents: answerDocuments.map(({ connection, resource, revision }) => ({ connection, resource, revision })),
              } });
              setAnswer(response);
            });
          }}>
            <ul aria-label="Selected documents">{answerDocuments.map((item, index) => <li key={item.connection + '/' + item.resource}>
              {item.resource} · {connections.find(connection => connection.id === item.connection)?.account ?? item.connection}{' '}
              <button type="button" onClick={() => setAnswerDocuments(documents => documents.filter((_, i) => i !== index))}>Remove</button>
            </li>)}</ul>
            <label>Question about selected documents<textarea name="question" required maxLength={4000} /></label>
            <small>This sends excerpts from the selected document revisions to the configured model.</small>
            <button>Ask Blazar about selected documents</button>
          </form>}
          {refreshConflicts.length > 0 && <section aria-label="Refresh conflicts">
            <p>Kept the primary revision for these documents because the fallback returned different content.</p>
            <ul>{refreshConflicts.map(resource => <li key={resource}>{resource}</li>)}</ul>
          </section>}
          <form key={importSource.id + (importSource.workspace ?? '')} onSubmit={event => {
            event.preventDefault();
            const { workspace, query } = Object.fromEntries(new FormData(event.currentTarget));
            void perform(async () => {
              const { items } = await request('/app-connections/' + importSource.id + '/capabilities/document.search', {
                method: 'POST', body: { workspace, query },
              });
              setDocumentMatches(items);
            });
          }}>
            <label>Search workspace<input name="workspace" defaultValue={importSource.workspace ?? ''}
              readOnly={Boolean(importSource.workspace)} onChange={() => setDocumentMatches(null)} required maxLength={128} /></label>
            <label>Search terms<input name="query" required maxLength={256} onChange={() => setDocumentMatches(null)} /></label>
            <button>Search imported documents</button>
          </form>
          {documentMatches && <section aria-label="Document search results">
            <p role="status">{documentMatches.length ? `${documentMatches.length} matching documents` : 'No matching documents.'}</p>
            {documentMatches.length > 0 && <ul>{documentMatches.map(item => (
              <li key={item.id}><strong>{item.resource}</strong><p>{item.excerpt}</p></li>
            ))}</ul>}
          </section>}
          {documentSync.filter(schedule => schedule.connection === importSource.id).map(schedule => (
            <p key={schedule.workspace}>{schedule.workspace} · Every {schedule.intervalMinutes} minutes</p>
          ))}
        </fieldset>
      )}
      </div>

      <div className="apps-tools" hidden={panel !== 'memory'}>
      <fieldset disabled={busy}>
        <legend>{t('Save memory', '保存记忆')}</legend>
        <form onSubmit={saveMemory}>
          <label>{t('Workspace', '工作区')}<input name="workspace" required maxLength={128} /></label>
          <label>{t('Memory', '记忆')}<textarea name="body" required maxLength={16000} /></label>
          <label>{t('Source', '来源')}<select value={selected} onChange={event => setSelected(event.target.value)}>
            <option value="">{t('Personal note', '个人笔记')}</option>
            {active.map(connection => <option key={connection.id} value={connection.id}>{accountName(connection)}</option>)}
          </select></label>
          {selected && <>
            <label>{t('Resource ID', '资源 ID')}<input name="resource" required maxLength={512} /></label>
            <label>{t('Revision', '版本')}<input name="revision" required maxLength={256} /></label>
          </>}
          <label>Expires at <input type="datetime-local" name="expires" /></label>
          <button>{t('Save memory', '保存记忆')}</button>
        </form>
      </fieldset>

      <fieldset disabled={busy}>
        <legend>{t('Search memory', '搜索记忆')}</legend>
        <form onSubmit={search}>
          <label>{t('Workspace', '工作区')}<input name="workspace" required maxLength={128} /></label>
          <label>Search terms<input name="q" required maxLength={256} /></label>
          <label>Source accounts<select name="source" multiple disabled={!active.length}>
            {active.map(connection => <option key={connection.id} value={connection.id}>{accountName(connection)}</option>)}
          </select></label>
          <label>Question for Blazar<textarea name="question" maxLength={4000} /></label>
          <button>{t('Search memory', '搜索记忆')}</button>
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
            {item.expires && <small> · Expires {new Date(item.expires).toLocaleString()}</small>}
            {source && (deriving?.id === item.id ? <form onSubmit={event => {
              event.preventDefault();
              const body = new FormData(event.currentTarget).get('body');
              void perform(async () => {
                await request('/memory', { method: 'POST', body: {
                  workspace: item.workspace, body, derivedFrom: { id: item.id, version: item.version },
                } });
                setDeriving(null);
                setNotice('Source-backed memory saved.');
              });
            }}>
              <label>Memory to save<textarea name="body" defaultValue={deriving.body} required maxLength={16000} /></label>
              <button>Confirm and save</button>
              <button type="button" onClick={() => setDeriving(null)}>Cancel</button>
            </form> : <>
              <button type="button" onClick={() => setDeriving({ id: item.id, body: '' })}>Draft memory from this source</button>
              <button type="button" onClick={() => void perform(async () => {
                const result = await request('/memory/draft', { method: 'POST', body: {
                  workspace: item.workspace, id: item.id, version: item.version,
                } });
                if (result.body === null) {
                  setNotice('Blazar found no reusable fact in this excerpt.');
                  return;
                }
                setDeriving({ id: item.id, body: result.body });
              })}>Ask Blazar to draft from this excerpt</button>
            </>)}
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
              {history.derivedFrom && <p>Evidence {history.derivedFrom.id} · version {history.derivedFrom.version}</p>}
              {history.edits.length > 0 && <ul>{history.edits.map(edit => <li key={edit.version}>
                Version {edit.version} replaced {new Date(edit.replacedAt).toLocaleString()}
              </li>)}</ul>}
              {history.sourceRevisions.length > 0 && <ul aria-label="Source revisions">{history.sourceRevisions.map(revision =>
                <li key={revision.id}><code>{revision.revision}</code> · {new Date(revision.created).toLocaleString()}
                  {revision.current ? ' · Current source' : ''}
                  {revision.backend && <> · {revision.backend.kind === 'github' ? 'GitHub API' : 'MCP'}
                    {revision.backend.fallback && ' fallback'}</>}
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
      </div>
      <LingerCredit />
    </section>
  );
}
