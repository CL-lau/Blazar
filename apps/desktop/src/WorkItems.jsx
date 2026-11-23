import { desktopStatus, useDesktopLanguage } from './DesktopLanguage.jsx';
import { DesktopIcon } from './DesktopIcon.jsx';
import { PageHeading } from './PageHeading.jsx';
import { LingerCredit } from './LingerCredit.jsx';
import React, { useState } from 'react';

import { dashboardColumnFor, dashboardColumns } from './vendor/linger/workItemColumns.ts';

const columnIcons = { todo: 'queue', 'in-progress': 'execution', done: 'outcome', closed: 'archive' };

export function WorkItems({ tasks, notifications, open }) {
  const { t } = useDesktopLanguage();
  const [workspace, setWorkspace] = useState('');
  const [closedExpanded, setClosedExpanded] = useState(true);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const actions = new Map();
  for (const notification of notifications) {
    const taskActions = actions.get(notification.task.id) ?? [];
    taskActions.push(notification);
    actions.set(notification.task.id, taskActions);
  }
  const filtered = tasks.filter(task => (!workspace || task.workspace === workspace) &&
    (!attentionOnly || actions.has(task.id) && task.status !== 'succeeded'));
  const workspaces = [...new Set(tasks.map(task => task.workspace))].sort();
  return <section className="detail work-items">
    <PageHeading title="Work items" description={t(filtered.length + (filtered.length === 1 ? ' task matches these filters.' : ' tasks match these filters.'), '符合筛选条件的任务共 ' + filtered.length + ' 项。')} />
    <div className="notification-heading work-item-filters">
      <label>{t('Workspace', '工作区')}<select value={workspace} onChange={event => setWorkspace(event.target.value)}>
        <option value="">{t('All workspaces', '所有工作区')}</option>
        {workspaces.map(name => <option key={name}>{name}</option>)}
      </select></label>
      <label className="checkbox-label"><input type="checkbox" checked={attentionOnly}
        onChange={event => setAttentionOnly(event.target.checked)} /> {t('Needs attention', '需要处理')}</label>
    </div>
    <div className="work-item-columns">{dashboardColumns.map(column => {
      const items = filtered.filter(task => dashboardColumnFor(task.status) === column.id);
      return <section key={column.id} aria-label={t(column.label)} data-column={column.id}>
        <header className="work-item-column-heading">
          <h3><DesktopIcon name={columnIcons[column.id]} size={14} />{t(column.label)}<small>{items.length}</small></h3>
          {column.id === 'closed' && <button type="button" aria-expanded={closedExpanded} aria-controls="closed-work-items"
            onClick={() => setClosedExpanded(value => !value)}>{closedExpanded ? t('Collapse', '收起') : t('Expand', '展开')}</button>}
        </header>
        {(column.id !== 'closed' || closedExpanded) && <div id={column.id === 'closed' ? 'closed-work-items' : undefined}>
        {items.length === 0 ? <p className="work-item-empty">{t('No tasks', '暂无任务')}</p> : <ul>{items.map(task => <li key={task.id} data-task-status={task.status}>
          <button type="button" className="notification-row" onClick={() => open(task)}>
            <strong>{task.goal}</strong>
            <DesktopIcon name="chevron" />
            <span className="work-item-workspace">{task.workspace}</span>
            <span className="component-status" data-tone={task.status}>{desktopStatus(t, task.status)}</span>
          </button>
          {(actions.get(task.id) ?? []).filter(item => !item.id.startsWith('schedule:')).map(item =>
            <div key={item.id} className="work-item-action" data-priority={task.status === 'failed' ? 'error' : 'attention'}>
              <button type="button" onClick={() => open(task, item.target)}>{t(item.title)}<DesktopIcon name="chevron" /></button>
              {item.detail && <small>{item.detail.slice(0, 160)}</small>}
            </div>)}
        </li>)}</ul>}
        </div>}
      </section>;
    })}</div>
    <LingerCredit />
  </section>;
}
