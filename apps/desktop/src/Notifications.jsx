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
      id: 'approval:' + approval.id, title: 'Approval required', task, target: 'approval-' + approval.id,
    });
  }
  for (const task of snapshot.tasks) {
    const status = task.status === 'waiting_review' ? ['review', 'Result ready for review'] :
      task.status === 'failed' ? ['failed', 'Task failed'] : null;
    if (status) notifications.push({
      id: status[0] + ':' + task.id + ':' + task.version,
      title: status[1], task, target: status[0] === 'review' ? 'result-review' : 'task-heading',
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
  return <section className="detail notification-inbox">
    <div className="notification-heading">
      <h2>Notifications</h2>
      <button type="button" disabled={items.every(item => read.has(item.id))}
        onClick={markAllRead}>Mark all as read</button>
    </div>
    {items.length === 0 ? <p>No notifications.</p> : <ul>{items.map(item => (
      <li key={item.id}>
        <button type="button" className="notification-row" onClick={() => open(item)}>
          <strong>{item.title}{read.has(item.id) ? '' : ' · Unread'}</strong>
          <span>{item.task.workspace} · {item.task.goal}</span>
        </button>
      </li>
    ))}</ul>}
  </section>;
}
