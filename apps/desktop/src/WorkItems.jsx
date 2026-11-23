import React, { useState } from 'react';

const columns = [
  { label: 'Needs attention', statuses: ['waiting_user', 'waiting_review', 'failed'] },
  { label: 'In progress', statuses: ['queued', 'running', 'waiting_dependency', 'waiting_device', 'pausing', 'paused', 'cancelling'] },
  { label: 'Closed', statuses: ['succeeded', 'cancelled'] },
];

export function WorkItems({ tasks, open }) {
  const [workspace, setWorkspace] = useState('');
  const workspaces = [...new Set(tasks.map(task => task.workspace))].sort();
  return <section className="detail work-items">
    <div className="notification-heading">
      <h2>Work items</h2>
      <label>Workspace<select value={workspace} onChange={event => setWorkspace(event.target.value)}>
        <option value="">All workspaces</option>
        {workspaces.map(name => <option key={name}>{name}</option>)}
      </select></label>
    </div>
    <div className="work-item-columns">{columns.map(column => {
      const items = tasks.filter(task => (!workspace || task.workspace === workspace) && column.statuses.includes(task.status));
      return <section key={column.label}>
        <h3>{column.label} <small>{items.length}</small></h3>
        {items.length === 0 ? <p>No tasks</p> : <ul>{items.map(task => <li key={task.id}>
          <button type="button" className="notification-row" onClick={() => open(task)}>
            <strong>{task.goal}</strong>
            <span>{task.workspace} · {task.status.replaceAll('_', ' ')}</span>
          </button>
        </li>)}</ul>}
      </section>;
    })}</div>
  </section>;
}
