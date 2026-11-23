import { useDesktopLanguage } from './DesktopLanguage.jsx';
import { DesktopIcon } from './DesktopIcon.jsx';
import { PageHeading } from './PageHeading.jsx';
import React from 'react';

const readKey = 'blazar.notifications.read.v1';

export function loadReadNotifications() {
  try {
    const items = JSON.parse(localStorage.getItem(readKey) ?? '[]');
    return Array.isArray(items) ? items.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function saveReadNotifications(items) {
  try { localStorage.setItem(readKey, JSON.stringify(items)); } catch { /* Continue with in-memory read state. */ }
}

export function taskNotifications(snapshot) {
  if (!snapshot) return [];
  const tasks = new Map(snapshot.tasks.map(task => [task.id, task]));
  const notifications = [];
  for (const approval of snapshot.approvals ?? []) {
    const task = tasks.get(approval.taskId);
    if (task) notifications.push({
      id: 'approval:' + approval.id, title: 'Approval required', detail: approval.summary, task, target: 'approval-' + approval.id,
    });
  }
  for (const task of snapshot.tasks) {
    const status = task.status === 'waiting_review' ? ['review', 'Result ready for review'] :
      task.status === 'failed' ? ['failed', 'Task failed'] :
      task.status === 'waiting_device' ? ['device', 'Waiting for an eligible device'] :
      task.status === 'waiting_user' && !notifications.some(item => item.task.id === task.id)
        ? ['input', 'Needs your attention'] : null;
    if (status) notifications.push({
      id: status[0] + ':' + task.id + ':' + task.version,
      title: status[1], task, detail: task.result,
      target: status[0] === 'review' || task.desktopReconciliationRequired ? 'result-review'
        : status[0] === 'failed' ? 'retry-task' : 'task-heading',
    });
  }
  for (const schedule of snapshot.completedSchedules ?? []) {
    const task = tasks.get(schedule.taskId);
    if (task) notifications.push({
      id: 'schedule:' + schedule.workflowId, title: schedule.label + ' completed', task, target: 'task-heading',
    });
  }
  return notifications;
}

export function Notifications({ items, read, open, markAllRead }) {
  const { t } = useDesktopLanguage();
  return <section className="detail notification-inbox">
    <PageHeading title="Notifications" description="Review approvals, results, and failures that need your attention."
      actions={<button type="button" disabled={items.every(item => read.has(item.id))} onClick={markAllRead}>{t('Mark all as read', '全部标为已读')}</button>} />
    {items.length === 0 ? <p>{t('No notifications.', '暂无通知。')}</p> : <ul>{items.map(item => (
      <li key={item.id} data-unread={!read.has(item.id)}>
        <button type="button" className="notification-row" onClick={() => open(item)}>
          <span className="notice-meta">
            <span className="component-status" data-tone={item.id.startsWith('approval:') ? 'attention' : item.task.status}>{t(item.title)}</span>
            {!read.has(item.id) && <small>{t('Unread', '未读')}</small>}
          </span>
          <DesktopIcon name="chevron" />
          <strong>{item.task.goal}</strong><span className="notice-workspace">{item.task.workspace}</span>
          {item.detail && <small className="notice-detail">{item.detail.slice(0, 240)}</small>}
        </button>
      </li>
    ))}</ul>}
  </section>;
}
