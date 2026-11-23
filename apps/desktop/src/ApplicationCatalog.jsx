import { useDesktopLanguage } from './DesktopLanguage.jsx';
import React, { useState } from 'react';
import { DesktopIcon } from './DesktopIcon.jsx';
import { groupCatalogApps } from './vendor/linger/appGroups.ts';
import { activeExternalConnections } from './vendor/linger/connectionState.ts';

const catalogDetails = {
  github: { icon: 'repository', description: 'Repository files and Markdown.' },
  feishu: { icon: 'documents', description: 'Documents from Feishu workspaces.' },
  lark: { icon: 'workspace', description: 'Documents from Lark workspaces.' },
  mcp: { icon: 'connected-tools', description: 'Documents and resources from an MCP server.' },
};

export function ApplicationMark({ id, label }) {
  const icon = catalogDetails[id]?.icon;
  return <span className="application-mark" data-app={id} aria-hidden="true">
    {icon ? <DesktopIcon name={icon} size={20} /> : label.slice(0, 2).toUpperCase()}
  </span>;
}

export function ApplicationCatalog({ definitions, connections, selected, select, loading, failed, retry }) {
  const { t } = useDesktopLanguage();
  const [query, setQuery] = useState('');
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [category, setCategory] = useState('all');
  const catalog = new Map(definitions.map(app => [app.id, { ...app, connections: [] }]));
  for (const connection of connections) {
    if (!catalog.has(connection.app)) {
      catalog.set(connection.app, { id: connection.app, label: connection.app, accounts: [], connections: [] });
    }
    catalog.get(connection.app).connections.push(connection);
  }
  const categories = groupCatalogApps([...catalog.values()]);
  const apps = [...catalog.values()].filter(app => {
    const text = [app.label, app.id, ...app.connections.map(account => account.account)].join(' ').toLowerCase();
    return text.includes(query.trim().toLowerCase()) && (!connectedOnly || activeExternalConnections(app.connections).length > 0);
  });
  const groups = groupCatalogApps(apps).filter(({ group }) => category === 'all' || group.id === category);

  if (loading) return <p role="status" className="apps-empty">{t('Loading applications…', '正在加载应用…')}</p>;
  if (failed) return <div className="apps-empty"><button type="button" onClick={retry}>{t('Retry loading applications', '重新加载应用')}</button></div>;

  return <div className="apps-catalog">
    <div className="apps-filters">
      <div className="apps-search"><DesktopIcon name="search" /><input aria-label={t('Search applications', '搜索应用')} placeholder={t('Search applications…', '搜索应用…')} type="search"
        value={query} onChange={event => setQuery(event.target.value)} /></div>
      <label><input type="checkbox" checked={connectedOnly} onChange={event => setConnectedOnly(event.target.checked)} /> {t('Connected only', '仅已连接')}</label>
    </div>
    <div className="apps-categories" aria-label={t('Application categories', '应用分类')} role="group">
      {[{ id: 'all', title: 'All' }, ...categories.map(({ group }) => group)].map(group =>
        <button type="button" key={group.id} aria-pressed={category === group.id}
          onClick={() => setCategory(group.id)}>{t(group.title)}</button>)}
    </div>
    {groups.length === 0 && <p role="status" className="apps-empty">
      {query.trim() ? t('No applications match your search.', '没有匹配的应用。') : connectedOnly ? t('No connected applications.', '暂无已连接的应用。') : t('No applications available.', '暂无可用应用。')}
    </p>}
    {groups.map(({ group, apps: entries }) => <section className="apps-group" key={group.id} aria-label={t(group.title)}>
      <h2>{t(group.title)}</h2>
      <div className="apps-grid">{entries.map(app => {
        const active = activeExternalConnections(app.connections);
        const configured = active.filter(account => account.canImportDocument ||
          account.capabilities?.some(capability => capability.state === 'configured') ||
          account.writeCapabilities?.length);
        const state = active.length
          ? configured.length === active.length ? 'connected' : 'attention'
          : 'available';
        return <button className="apps-card" type="button" key={app.id} onClick={event => select(app.id, event.currentTarget)}
          aria-pressed={app.id === selected}>
          <ApplicationMark id={app.id} label={app.label} />
          <span className="apps-card-content">
            <strong>{app.label}</strong>
            <span>{t(catalogDetails[app.id]?.description ?? 'Application source accounts.')}</span>
          </span>
          <span className="apps-card-meta">
            <span className={state === 'available' ? 'apps-card-available' : 'component-status'} data-tone={state}>
              {state === 'attention' ? t('Setup required', '待配置') : active.length > 0
                ? t(active.length + (active.length === 1 ? ' account' : ' accounts'), active.length + ' 个账号') : t('Available', '可用')}
            </span>
            <DesktopIcon name="chevron" />
          </span>
        </button>;
      })}</div>
    </section>)}
  </div>;
}
