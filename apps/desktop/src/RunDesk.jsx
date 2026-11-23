import { desktopStatus, useDesktopLanguage } from './DesktopLanguage.jsx';
import { PageHeading } from './PageHeading.jsx';
import React from 'react';
import { DesktopIcon } from './DesktopIcon.jsx';
import './run-desk.css';

const stages = [
  { id: 'queue', label: 'Queue' },
  { id: 'execution', label: 'Execution' },
  { id: 'decision', label: 'Decision' },
  { id: 'outcome', label: 'Outcome' },
];

function stageFor(task) {
  switch (task.status) {
    case 'waiting_user': case 'waiting_review': case 'failed': return 'decision';
    case 'running': case 'paused': case 'pausing': case 'cancelling': return 'execution';
    case 'succeeded': case 'cancelled': return 'outcome';
    default: return 'queue';
  }
}

function workstreams(tasks, workflowSteps) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const workflowFor = new Map(workflowSteps.map(step => [step.taskId, step.workflowId]));
  const groups = new Map();
  for (const task of tasks) {
    const id = workflowFor.get(task.id) ?? task.id;
    if (!groups.has(id)) groups.set(id, { id, workspace: task.workspace, steps: [] });
    if (!workflowFor.has(task.id)) groups.get(id).steps.push(task);
  }
  const included = new Set();
  for (const step of workflowSteps) {
    const task = byId.get(step.taskId);
    if (task && !included.has(task.id)) {
      groups.get(step.workflowId)?.steps.push(task);
      included.add(task.id);
    }
  }
  return [...groups.values()].filter(group => group.steps.length);
}

export function RunDesk({ tasks, workflowSteps, notifications, open, create, createWithMemory, manageMemory, filters, setFilters }) {
  const { t } = useDesktopLanguage();
  const { workspace, stage } = filters;
  const options = [...new Set(tasks.map(task => task.workspace))].sort();
  const scoped = tasks.filter(task => !workspace || task.workspace === workspace);
  const attention = notifications.filter(item => stageFor(item.task) === 'decision' &&
    (!workspace || item.task.workspace === workspace));
  const counts = { queue: 0, execution: 0, decision: 0, outcome: 0 };
  for (const task of scoped) counts[stageFor(task)] += 1;
  const rows = workstreams(scoped, workflowSteps)
    .filter(group => !stage || group.steps.some(task => stageFor(task) === stage));
  return <section className="run-desk" aria-labelledby="run-desk-title">
    <PageHeading id="run-desk-title" title="Run desk" description={t("Give your Agent a goal, track the work, and review the result.", "给 Agent 一个目标，跟进执行过程，并验收结果。")}
      actions={<button type="button" className="primary desk-action" onClick={create}>
        <DesktopIcon name="add" /> {t("New task")}
      </button>} />
    <div className="desk-overview">
      <section className="desk-agent" aria-labelledby="desk-agent-title">
        <span className="desk-agent-mark"><DesktopIcon name="agent" size={24} /></span>
        <div>
          <h2 id="desk-agent-title">{t('Your personal Agent', '你的个人 Agent')}</h2>
          <p>{t('Bring your saved preferences and notes into a new task. You choose what to share and review what comes back.',
            '新任务可以使用你保存的偏好和笔记。由你决定提供哪些信息，并验收交付结果。')}</p>
          <div className="desk-agent-actions">
            <button type="button" onClick={createWithMemory}>
              {t('Start with personal memory', '新建任务并使用个人记忆')} <DesktopIcon name="chevron" />
            </button>
            <button type="button" className="desk-memory-link" onClick={manageMemory}><DesktopIcon name="memory" size={15} />{t('Manage memory', '管理记忆')}</button>
          </div>
        </div>
      </section>
      <section className="desk-progress" aria-label={t('Task progress', '任务进度')}>
        {stages.map(item => <button type="button" key={item.id} data-stage={item.id}
          aria-controls="desk-workstreams" aria-pressed={stage === item.id} onClick={() => setFilters({ ...filters, stage: stage === item.id ? '' : item.id })}>
          <span className="desk-stage-label"><DesktopIcon name={item.id} size={15} />{t(item.label)}</span><strong>{counts[item.id]}</strong>
          <DesktopIcon name="chevron" />
        </button>)}
      </section>
    </div>
    <div className="run-layout">
      <div id="desk-workstreams" className="run-main">
        <div className="run-controls">
          <h2>{t("Workstreams", "任务流程")}</h2>
          <label>{t("Workspace")}<select value={workspace} onChange={event => setFilters({ ...filters, workspace: event.target.value })}>
            <option value="">{t("All workspaces")}</option>
            {options.map(name => <option key={name}>{name}</option>)}
          </select></label>
        </div>
        {stage && <button className="desk-clear-filter" type="button" onClick={() => setFilters({ ...filters, stage: '' })}>
          <DesktopIcon name="close" /> {t('Clear stage filter', '清除阶段筛选')}
        </button>}
        {rows.length > 0 ? <div className="run-matrix-scroll" tabIndex={0} aria-label={t("Workstreams by stage", "按阶段查看任务流程")}>
          <table className="run-matrix">
            <thead><tr><th scope="col">{t("Workstream", "任务流程")}</th>{stages.map(item => <th key={item.id} scope="col">{t(item.label)}</th>)}</tr></thead>
            <tbody>{rows.map(group => <tr key={group.id}>
              <th scope="row"><strong>{group.steps[0].goal}</strong>
                <small>{group.workspace} · {group.steps.length === 1 ? t('Single task', '单个任务') : t(group.steps.length + ' steps', group.steps.length + ' 个步骤')}</small>
              </th>
              {stages.map(item => <td key={item.id} data-stage={item.id}>
                {group.steps.filter(task => stageFor(task) === item.id).map(task =>
                  <button type="button" key={task.id} onClick={() => open(task)}
                    aria-label={task.goal + ' · ' + desktopStatus(t, task.status)}>
                    {group.steps.length > 1 && <span className="run-step-goal">{task.goal}</span>}
                    <span className="component-status run-status-label" data-tone={task.status}>{desktopStatus(t, task.status)}</span>
                  </button>)}
              </td>)}
            </tr>)}</tbody>
          </table>
        </div> : <p className="run-empty">{scoped.length ? t('No workstreams in this stage.', '此阶段暂无任务。') : t('No tasks in this workspace. Start with a goal and its context.', '此工作区暂无任务。写下目标即可开始。')}</p>}
      </div>
      <aside className="run-decisions" aria-label={t("Decision queue", "待你处理")}>
        <h2>{t("Decision queue", "待你处理")} <span>{attention.length}</span></h2>
        {attention.length > 0 ? <ul>{attention.map(item => <li key={item.id}>
          <button type="button" onClick={() => open(item.task, item.target)}>
            <span className="component-status" data-tone={item.id.startsWith('approval:') ? 'attention' : item.task.status}>{t(item.title)}</span>
            <DesktopIcon name="chevron" />
            <strong>{item.task.goal}</strong><small>{item.task.workspace}</small>
          </button>
        </li>)}</ul> : <p>{t("Approvals, result reviews, and failures will appear here.", "待批准的操作、待验收的结果与失败任务会显示在这里。")}</p>}
      </aside>
    </div>
  </section>;
}

export function TaskRoute({ task, steps, open, inspectDecision, inspectResult, inspectActivity }) {
  const { t } = useDesktopLanguage();
  const current = stageFor(task);
  const actions = { queue: () => document.getElementById('task-heading')?.focus(),
    execution: inspectActivity, decision: inspectDecision, outcome: inspectResult };
  return <section className="task-route" aria-label={t("Task route", "任务进度")}>
    <ol>{stages.map(item => <li key={item.id} data-current={item.id === current}>
      {actions[item.id]
        ? <button type="button" aria-current={item.id === current ? 'step' : undefined} onClick={actions[item.id]}><DesktopIcon name={item.id} size={15} />{t(item.label)}</button>
        : <span aria-current={item.id === current ? 'step' : undefined}><DesktopIcon name={item.id} size={15} />{t(item.label)}</span>}
    </li>)}</ol>
    {steps.length > 1 && <nav aria-label={t("Workflow steps", "任务步骤")}>
      {steps.map(item => <button type="button" key={item.id}
        aria-current={item.id === task.id ? 'step' : undefined} onClick={() => open(item)}>
        <span>{item.goal}</span><small>{desktopStatus(t, item.status)}</small>
      </button>)}
    </nav>}
  </section>;
}
