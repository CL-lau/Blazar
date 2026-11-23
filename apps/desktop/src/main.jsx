import { desktopStatus, DesktopLanguage, LanguagePicker, useDesktopLanguage } from './DesktopLanguage.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { createRoot } from 'react-dom/client';
import { PairingCode } from './PairingCode.jsx';
import { Timeline } from './Timeline.jsx';
import { Knowledge } from './Knowledge.jsx';
import { Wiki } from './Wiki.jsx';
import { Schedules } from './Schedules.jsx';
import { ArtifactPreview } from './ArtifactPreview.jsx';
import { ChannelLinks } from './ChannelLinks.jsx';
import { DesktopControl } from './DesktopControl.jsx';
import { AgentInstallations } from './AgentInstallations.jsx';
import { Devices } from './Devices.jsx';
import { Notifications, loadReadNotifications, saveReadNotifications, taskNotifications } from './Notifications.jsx';
import { WorkItems } from './WorkItems.jsx';
import { PageHeading } from './PageHeading.jsx';
import { DesktopIcon } from './DesktopIcon.jsx';
import { DesktopNavigation } from './DesktopNavigation.jsx';
import { ConnectedTools } from './ConnectedTools.jsx';
import { RunDesk, TaskRoute } from './RunDesk.jsx';
import { SidebarResize, useSidebarWidth } from './SidebarResize.jsx';
import { RouterStatus } from './RouterStatus.jsx';
import { callRouter } from './router.js';
import { MiddleTruncate } from './vendor/t3/MiddleTruncate.tsx';
import './style.css';
import './workbench.css';

async function readTaskFiles(files) {
  if (files.length > 4 || files.some(file => file.size > 8192) ||
      files.reduce((total, file) => total + file.size, 0) > 16384) {
    throw new Error('Choose up to four text files, at most 8 KiB each and 16 KiB total.');
  }
  return Promise.all(files.map(async file => {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
    catch { throw new Error('Each attachment must contain UTF-8 text.'); }
    if (!text.trim()) throw new Error('Attachments cannot be empty.');
    return { name: file.name, text };
  }));
}

function WorkspaceResource({ settings, workspace, setWorkspace, token, reviewId, workflowSteps, showTask }) {
  const { t } = useDesktopLanguage();
  const scope = <label className="resource-scope">{t('Workspace', '工作区')}<input value={workspace}
    onChange={event => setWorkspace(event.target.value)} maxLength={128} /></label>;
  const name = workspace.trim();
  if (!name) return <section className="detail">
    <PageHeading title={settings === 'wiki' ? 'Wiki' : 'Schedules'} actions={scope} />
    <p className="muted">{t('Enter a workspace to continue.', '请输入工作区后继续。')}</p>
  </section>;
  return settings === 'wiki'
    ? <Wiki key={name + reviewId} token={token} workspace={name} reviewId={reviewId} scope={scope} />
    : <Schedules key={name} token={token} workspace={name} workflowSteps={workflowSteps} scope={scope} showTask={showTask} />;
}

function App() {
  const { t } = useDesktopLanguage();
  const native = isTauri();
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();
  const [token, setToken] = useState('');
  const [connected, setConnected] = useState('');
  const [localRouter, setLocalRouter] = useState('checking');
  const [registeredAgentRevision, setRegisteredAgentRevision] = useState(0);
  const [readNotifications, setReadNotifications] = useState(loadReadNotifications);
  const [notificationTarget, setNotificationTarget] = useState(null);
  const [workflowAgents, setWorkflowAgents] = useState([]);
  const [agentAssignments, setAgentAssignments] = useState({});
  const [workflowAgentError, setWorkflowAgentError] = useState('');
  const [settingUpRouter, setSettingUpRouter] = useState(false);
  const [setupError, setSetupError] = useState('');
  async function startLocalRouter() {
    setSettingUpRouter(true);
    setSetupError('');
    try {
      await invoke('start_local_router');
      setSnapshot(await callRouter('', '/state'));
      setConnected('local');
      setSyncError('');
    } catch (failure) {
      setSetupError(failure.message ?? String(failure));
    } finally {
      setSettingUpRouter(false);
    }
  }
  const [snapshot, setSnapshot] = useState(null);
  const [syncError, setSyncError] = useState('');
  const snapshotSequence = useRef({ requested: 0, applied: 0 });
  const [selected, setSelected] = useState('');
  const [workspace, setWorkspace] = useState('default');
  const [goal, setGoal] = useState('');
  const [copiedFromTask, setCopiedFromTask] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [usePersonalMemory, setUsePersonalMemory] = useState(false);
  const [answer, setAnswer] = useState('');
  const [conversation, setConversation] = useState({});
  const [wikiReviewId, setWikiReviewId] = useState('');
  const [knowledgePanel, setKnowledgePanel] = useState('applications');
  const [retryWorkers, setRetryWorkers] = useState(null);
  const [retryDevice, setRetryDevice] = useState('');
  const turns = conversation[workspace.trim()] ?? [];
  const [savedResult, setSavedResult] = useState(null);
  const [phoneGrants, setPhoneGrants] = useState(null);
  const [memoryAnswer, setMemoryAnswer] = useState(null);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memoryAccounts, setMemoryAccounts] = useState([]);
  const [memorySources, setMemorySources] = useState([]);
  const [plan, setPlan] = useState(null);
  const [followUp, setFollowUp] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [settings, setSettings] = useState('tasks');
  const [briefOpen, setBriefOpen] = useState(false);
  const [deskFilters, setDeskFilters] = useState({ workspace: '', stage: '' });
  const [pairing, setPairing] = useState(null);
  const [clients, setClients] = useState([]);
  const [pairingRequests, setPairingRequests] = useState([]);

  useEffect(() => {
    const thread = workspace.trim();
    if (!connected || !thread) return;
    const controller = new AbortController();
    callRouter(connected, '/conversation?workspace=' + encodeURIComponent(thread) + '&links=1', { signal: controller.signal })
      .then(({ turns: history }) => {
        if (!controller.signal.aborted) setConversation(current =>
          Object.hasOwn(current, thread) ? current : { ...current, [thread]: history.map((turn, index) => ({
            ...turn, id: turn.id ?? 'history-' + index,
          })) });
      })
      .catch(() => { /* The composer remains available if history could not be loaded. */ });
    return () => controller.abort();
  }, [connected, workspace]);

  useEffect(() => {
    if (connected) return;
    const stop = new AbortController();
    let timer;
    async function check() {
      try {
        if (native) {
          const state = await callRouter('', '/state', { signal: stop.signal });
          if (!stop.signal.aborted) {
            setSnapshot(state);
            setConnected('local');
          }
          return;
        }
        const health = await callRouter('', '/health', { signal: stop.signal });
        if (!stop.signal.aborted) setLocalRouter(
          health?.service === 'blazar-router' && health.status === 'ready' ? 'ready' : 'unavailable');
      } catch (failure) {
        if (!stop.signal.aborted) setLocalRouter(native ? failure.message : 'unavailable');
      } finally {
        if (!stop.signal.aborted) timer = setTimeout(check, 5_000);
      }
    }
    void check();
    return () => { stop.abort(); clearTimeout(timer); };
  }, [connected, native]);

  useEffect(() => {
    if (!preview?.expires) return;
    const expire = setTimeout(() => setPreview(null), Math.max(0, preview.expires - Date.now()));
    return () => clearTimeout(expire);
  }, [preview]);

  async function refreshSnapshot(token, signal) {
    const sequence = ++snapshotSequence.current.requested;
    const next = await callRouter(token, '/state', { signal });
    if (!signal?.aborted && sequence > snapshotSequence.current.applied) {
      snapshotSequence.current.applied = sequence;
      setSnapshot(next);
    }
    return next;
  }

  useEffect(() => {
    if (!connected) return;
    const stop = new AbortController();

    async function sync() {
      while (!stop.signal.aborted) {
        try {
          const next = await refreshSnapshot(connected, stop.signal);
          if (stop.signal.aborted) return;
          setSyncError('');
          await callRouter(connected, '/stream?once=1&after=' + next.cursor, { signal: stop.signal });
        } catch (failure) {
          if (stop.signal.aborted) return;
          if (failure.status === 409) continue;
          setSyncError(failure.message);
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }
    }

    void sync();
    return () => stop.abort();
  }, [connected]);

  useEffect(() => {
    if (!connected || settings !== 'tasks') return;
    const stop = new AbortController();
    callRouter(connected, '/app-connections', { signal: stop.signal })
      .then(data => { if (!stop.signal.aborted) setMemoryAccounts(data.connections); })
      .catch(() => {});
    return () => stop.abort();
  }, [connected, settings]);

  useEffect(() => {
    if (!connected || settings !== 'phones') return;
    const stop = new AbortController();
    let timer;
    async function refreshPairingRequests() {
      try {
        const data = await callRouter(connected, '/admin/mobile-pairings', { signal: stop.signal });
        if (!stop.signal.aborted) setPairingRequests(data.requests);
      } catch {
        // Retry when the Router is reachable.
      } finally {
        if (!stop.signal.aborted) timer = setTimeout(refreshPairingRequests, 2_000);
      }
    }
    void refreshPairingRequests();
    return () => { stop.abort(); clearTimeout(timer); };
  }, [connected, settings]);

  async function submit(action) {
    setBusy(true);
    setError('');
    try { await action(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    setAgentAssignments({});
    setWorkflowAgents([]);
    setWorkflowAgentError('');
    if (!plan || !connected) return;
    const abort = new AbortController();
    callRouter(connected, '/admin/devices', { signal: abort.signal }).then(({ devices }) => {
      if (!abort.signal.aborted) setWorkflowAgents(devices);
    }).catch(failure => {
      if (!abort.signal.aborted) setWorkflowAgentError(failure.message);
    });
    return () => abort.abort();
  }, [connected, plan]);

  useEffect(() => {
    if (!notificationTarget || settings !== 'tasks') return;
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(notificationTarget) ?? document.getElementById('task-heading');
      element?.focus();
      element?.scrollIntoView({ block: 'nearest' });
      setNotificationTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [notificationTarget, settings, selected]);

  const notifications = taskNotifications(snapshot);
  const readNotificationIds = new Set(readNotifications);
  const unreadCount = notifications.filter(item => !readNotificationIds.has(item.id)).length;
  function markNotificationsRead(ids) {
    const changed = new Set([...readNotificationIds, ...ids]);
    const recent = [...changed].slice(-1000);
    setReadNotifications(recent);
    saveReadNotifications(recent);
  }
  function openDesk() {
    setSettings('tasks');
    setSelected('');
    setBriefOpen(false);
    setPreview(null);
  }

  function openBrief() {
    openDesk();
    setBriefOpen(true);
  }

  function openAgentMemory() {
    setKnowledgePanel('memory');
    setSettings('knowledge');
  }

  function openAgentBrief() {
    setUsePersonalMemory(true);
    setKey(crypto.randomUUID());
    openBrief();
  }

  function openTask(item, target = 'task-heading') {
    setWorkspace(item.workspace);
    setSelected(item.id);
    setBriefOpen(false);
    setInstruction('');
    setPreview(null);
    setSettings('tasks');
    setNotificationTarget(target);
  }
  const task = snapshot?.tasks.find(item => item.id === selected);
  const tasksByWorkspace = new Map();
  for (const item of snapshot?.tasks ?? []) {
    const group = tasksByWorkspace.get(item.workspace);
    if (group) group.push(item);
    else tasksByWorkspace.set(item.workspace, [item]);
  }
  const memoryUnavailable = task?.appMemoryUnavailable || task?.personalMemoryUnavailable;
  const configuredWorker = snapshot?.workflowSteps?.find(step => step.taskId === selected)?.workerDeviceId;
  const dependencies = (snapshot?.workflowSteps ?? [])
    .filter(link => link.taskId === selected && link.predecessorId)
    .map(link => snapshot.tasks.find(item => item.id === link.predecessorId)).filter(Boolean);
  const workflowId = snapshot?.workflowSteps?.find(link => link.taskId === selected)?.workflowId;
  const workflowTasks = workflowId ? [...new Set(snapshot.workflowSteps
    .filter(link => link.workflowId === workflowId).map(link => link.taskId))]
    .map(id => snapshot.tasks.find(item => item.id === id)).filter(Boolean) : [];
  const artifacts = snapshot?.artifacts.filter(item => item.taskId === selected) ?? [];
  useEffect(() => {
    setRetryWorkers(null);
    setRetryDevice('');
  }, [selected, task?.version]);

  const reviewArtifact = artifacts.find(item => item.name === 'git-changes.json' && item.version === task?.version);
  const taskAttachments = snapshot?.attachments?.filter(item => item.taskId === selected) ?? [];
  const visiblePreview = preview?.taskId === task?.id && preview && (preview.attachmentPosition === undefined
    ? preview.artifactIds.every(id => artifacts.some(item => item.id === id))
    : taskAttachments.some(item => item.position === preview.attachmentPosition));
  const criteria = snapshot?.criteria?.filter(item => item.taskId === selected) ?? [];
  const progress = snapshot?.progress?.find(item => item.taskId === selected);
  const taskApprovals = snapshot?.approvals.filter(item => item.taskId === task?.id) ?? [];
  const linkedTurns = task ? turns.filter(turn => turn.taskId === task.id ||
    workflowTasks.some(step => step.id === turn.taskId)) : turns;
  const availableSources = memoryAccounts.filter(account =>
    account.active && (!account.workspace || account.workspace === workspace.trim()));
  const chosenSources = availableSources.filter(account => memorySources.includes(account.id));
  const api = (path, options) => callRouter(connected, path, options);
  const createWorkflow = appMemory => submit(async () => {
    const created = await api('/workflows', {
      method: 'POST', key: plan.key, body: { workspace: plan.workspace, steps: plan.steps, proposalKey: plan.proposalKey, agentAssignments, appMemory },
    });
    const taskId = created.steps[0].taskId;
    const thread = plan.workspace.trim();
    setConversation(current => ({ ...current, [thread]: (current[thread] ?? []).map(turn =>
      turn.id === plan.proposalKey ? { ...turn, taskId } : turn) }));
    setSelected(taskId);
    setBriefOpen(false);
    setPlan(null);
    setAnswer('');
    await reload();
  });
  function startDraftFromTask() {
    setGoal(task.goal);
    setWorkspace(task.workspace);
    setCopiedFromTask({ id: task.id, requiresAppMemory: task.usesAppMemory === true });
    setUsePersonalMemory(false);
    setMemorySources([]);
    setMemoryQuery('');
    setAttachments([]);
    setAnswer('');
    setMemoryAnswer(null);
    setFollowUp(null);
    setPlan(null);
    setPreview(null);
    setKey(crypto.randomUUID());
    setSelected('');
    setBriefOpen(true);
  }
  const reload = () => refreshSnapshot(connected);
  const previewArtifact = item => submit(async () => {
    const ids = { taskId: item.taskId, artifactIds: [item.id], name: item.name };
    if (item.mime === 'image/png') {
      const { png } = await api('/artifacts/' + item.id + '/image');
      setPreview({ ...ids, png, expires: item.expires });
    } else {
      setPreview({ ...ids, text: await api('/artifacts/' + item.id) });
    }
  });
  const command = (action, extra = {}) => submit(async () => {
    await api(`/tasks/${task.id}/commands`, {
      method: 'POST', key: crypto.randomUUID(), body: { action, expectedVersion: task.version, ...extra },
    });
    setInstruction('');
    await reload();
  });

  return (
    <main className={connected ? 'app-shell' : 'connection-shell'}
      style={connected ? { '--sidebar-width': sidebarWidth + 'px' } : undefined}>
      <a className="skip-to-content" href="#desktop-content">{t('Skip to content', '跳到主内容')}</a>
      {connected ? (
        <aside className="task-sidebar" id="blazar-navigation" aria-label="Blazar navigation">
          <DesktopNavigation current={settings} unread={unreadCount}
            create={openBrief}
            choose={id => {
              if (id === 'tasks') { openDesk(); return; }
              if (id === 'phones') {
                submit(async () => {
                  setClients((await api('/admin/mobile-clients')).clients);
                  setSettings(id);
                });
                return;
              }
              if (id === 'knowledge') { setKnowledgePanel('applications'); setMemoryAnswer(null); setPreview(null); }
              if (id === 'wiki') setWikiReviewId('');
              setSettings(id);
            }} />
          <div className="thread-list" aria-label="Recent tasks">
            {Array.from(tasksByWorkspace, ([name, tasks]) => (
              <section key={name} className="task-group">
                <h2>{name}</h2>
                <ul>{tasks.map(item => (
                  <li key={item.id}>
                    <button className="task-link" aria-current={item.id === selected ? 'true' : undefined}
                      onClick={() => openTask(item)}>
                      <span className="thread-dot" data-status={item.status} aria-label={desktopStatus(t, item.status)} />
                      <span className="thread-title" title={item.goal}>{item.goal}</span>
                    </button>
                  </li>
                ))}</ul>
              </section>
            ))}
          </div>
          <SidebarResize width={sidebarWidth} setWidth={setSidebarWidth} />
        </aside>
      ) : <header className="app-bar"><strong>Blazar</strong><LanguagePicker /></header>}
      <div className="app-content" id="desktop-content" tabIndex={-1}>
      {(error || syncError) && <p className="error" role="alert">{error || syncError}</p>}
      {native && connected && syncError && (
        <div className="router-recovery">
          <button disabled={settingUpRouter} onClick={startLocalRouter}>
            {settingUpRouter ? 'Starting Router…' : 'Recover local Router'}
          </button>
          {setupError && <p className="error" role="alert">{setupError}</p>}
        </div>
      )}
      {!connected ? (
        <section className="connection-layout" aria-label={t('Blazar setup', '设置 Blazar')}>
          <div className="connection-intro">
            <h1>{t('Local Agent workspace', '个人 Agent 工作区')}</h1>
            <ol aria-label="Task stages">
              <li><DesktopIcon name="work-items" /><span>{t('Queue work', '安排任务')}</span></li>
              <li><DesktopIcon name="devices" /><span>{t('Run on your devices', '在你的设备上执行')}</span></li>
              <li><DesktopIcon name="outcome" /><span>{t('Review results', '验收结果')}</span></li>
            </ol>
          </div>
          {native ? (
        <section className="connect">
          <h2>{t('Blazar setup', '设置 Blazar')}</h2>
          <p role="status">{settingUpRouter ? 'Starting the local Router…' :
            localRouter === 'checking' ? 'Connecting to the local Router…' : localRouter}</p>
          {setupError && <p className="error" role="alert">{setupError}</p>}
          <button className="primary" disabled={settingUpRouter || localRouter === 'checking'}
            onClick={startLocalRouter}>{t('Set up or start Router', '设置或启动路由')}</button>
        </section>
      ) : (
        <form className="connect" onSubmit={event => {
          event.preventDefault();
          submit(async () => {
            setSnapshot(await callRouter(token, '/state'));
            setConnected(token);
            setToken('');
          });
        }}>
          <h2>{t('Connect to your Router', '连接路由')}</h2>
          <p role="status">{t({
            checking: 'Checking the local Router…',
            ready: 'The local Router is ready.',
            unavailable: 'The local Router is unavailable. Start the Router service, then try again.',
          }[localRouter], {
            checking: '正在检查本地路由…',
            ready: '本地路由已就绪。',
            unavailable: '本地路由不可用。请启动路由服务后重试。',
          }[localRouter])}</p>
          <label>{t('Access token', '访问令牌')}<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} required /></label>
          <button className="primary" disabled={busy}>{t('Connect', '连接')}</button>
        </form>
        )}
        </section>
      ) : settings === 'connected-tools' ? (
        <ConnectedTools />
      ) : settings === 'work-items' ? (
        <WorkItems tasks={snapshot?.tasks ?? []} notifications={notifications} open={openTask} />
      ) : settings === 'notifications' ? (
        <Notifications items={notifications} read={readNotificationIds} open={item => { markNotificationsRead([item.id]); openTask(item.task, item.target); }}
          markAllRead={() => markNotificationsRead(notifications.map(item => item.id))} />
      ) : settings === 'knowledge' ? (
        <Knowledge key={knowledgePanel} token={connected} initialPanel={knowledgePanel} />
      ) : settings === 'wiki' || settings === 'schedules' ? (
        <WorkspaceResource settings={settings} workspace={workspace} setWorkspace={setWorkspace}
          token={connected} reviewId={wikiReviewId} workflowSteps={snapshot?.workflowSteps ?? []}
          showTask={id => { const item = snapshot?.tasks.find(task => task.id === id); if (item) openTask(item); }} />
      ) : settings === 'devices' ? (
        <>{native && <AgentInstallations workspace={workspace}
          onAdded={() => setRegisteredAgentRevision(value => value + 1)} />}
          <Devices key={registeredAgentRevision} token={connected} /></>
      ) : settings === 'desktop-control' ? (
        <DesktopControl targets={snapshot?.desktopTargets ?? []} tasks={snapshot?.tasks ?? []}
          workspace={workspace} setWorkspace={setWorkspace} busy={busy}
          createTask={async (body, key) => {
            let task;
            await submit(async () => {
              task = await api('/events', { method: 'POST', key, body });
              await reload();
            });
            return task;
          }}
          showTask={id => {
            setSelected(id);
            setInstruction('');
            setPreview(null);
            setSettings('tasks');
          }} />
      ) : settings === 'router-status' ? (
        <RouterStatus token={connected} />
      ) : settings === 'phones' ? (
        <section className="detail pairing-page">
          <PageHeading title="Linked phones" description="Manage phones authorized to review tasks and approvals."
            actions={<button className="primary" disabled={busy} onClick={() => submit(async () => {
              setPairing(await api('/pairings', { method: 'POST' }));
            })}>Create pairing code</button>} />
          <div className={pairing ? 'page-split plan-layout' : undefined}>
          <section className="page-pane" aria-label="Paired phones">
          <h2>Paired devices</h2>
          {!clients.length && <p className="muted">No phones are paired with this Router.</p>}
          {pairingRequests.length > 0 && <section aria-label="Pairing requests">
            <h3>Pairing requests</h3>
            <ul>{pairingRequests.map(request => <li key={request.id}>
              {request.name}{' '}
              {[true, false].map(approve => <button key={String(approve)} disabled={busy} onClick={() => submit(async () => {
                await api('/admin/mobile-pairings/' + request.id, { method: 'POST', body: { approve } });
                setPairingRequests(items => items.filter(item => item.id !== request.id));
                setClients((await api('/admin/mobile-clients')).clients);
              })}>{approve ? 'Approve' : 'Deny'}</button>)}
            </li>)}</ul>
          </section>}
          <ul>{clients.map(client => <li key={client.id}>
            {client.name} <button disabled={busy} onClick={() => submit(async () => {
              await api('/admin/mobile-clients/' + client.id, { method: 'DELETE' });
              setClients((await api('/admin/mobile-clients')).clients);
            })}>Revoke</button>
          </li>)}</ul>
          </section>
          {pairing && <section className="page-pane" aria-label="Pair a phone"><h2>Pair a phone</h2>
            <PairingCode key={pairing.code} pairing={pairing} />
          </section>}
          </div>
        </section>
      ) : !task && !briefOpen ? (
        <RunDesk tasks={snapshot?.tasks ?? []} workflowSteps={snapshot?.workflowSteps ?? []}
          notifications={notifications} open={openTask} create={openBrief} createWithMemory={openAgentBrief} manageMemory={openAgentMemory} filters={deskFilters} setFilters={setDeskFilters} />
      ) : (
        <div className={visiblePreview ? 'workspace with-preview' : 'workspace'}>
          <section className="detail">
            <header className="conversation-heading">
              <div className="workspace-breadcrumb">
                <button type="button" onClick={openDesk}>{t('Run desk', '任务台')}</button>
                <strong><MiddleTruncate value={workspace.trim() || 'Blazar'} /></strong>
              </div>
              {task && <span className="task-state" data-state={task.status}>{desktopStatus(t, task.status)}</span>}
            </header>
            {task && (
              <section className="task-detail" aria-labelledby="task-heading">
                <h1 id="task-heading" tabIndex={-1}>{task.goal}</h1>
                <TaskRoute task={task} steps={workflowTasks} open={openTask}
                  inspectDecision={(taskApprovals.length || ['waiting_review', 'failed', 'waiting_user'].includes(task.status))
                    ? () => setNotificationTarget(taskApprovals.length ? 'approval-' + taskApprovals[0].id :
                      ['failed', 'waiting_user'].includes(task.status) && !task.desktopReconciliationRequired
                        ? 'retry-task' : 'result-review') : undefined}
                  inspectResult={artifacts.length || task.result ? () => {
                    if (artifacts.length) previewArtifact(reviewArtifact ?? artifacts[0]);
                    else setNotificationTarget('task-outcome');
                  } : undefined}
                  inspectActivity={!memoryUnavailable ? () => {
                    const activity = document.getElementById('task-activity');
                    if (activity) { activity.open = true; setNotificationTarget('task-activity'); }
                  } : undefined} />
                {configuredWorker && <p>{t('Assigned device', '分配的设备')} <code>{configuredWorker}</code></p>}
                {dependencies.length > 0 && <section aria-label={t('Dependencies', '依赖关系')}>
                  <h3>{t('Upstream steps', '前置任务')}</h3>
                  <ul>{dependencies.map(item => <li key={item.id}>
                    <button type="button" onClick={() => { setSelected(item.id); setInstruction(''); setPreview(null); }}>
                      {item.goal} · {desktopStatus(t, item.status)}
                    </button>
                  </li>)}</ul>
                </section>}
                {criteria.length > 0 && <section aria-label={t('Acceptance criteria', '验收标准')}>
                  <h3>{t('Acceptance criteria', '验收标准')}</h3>
                  <ul>{criteria.map(item => <li key={item.criterion}>{item.criterion}</li>)}</ul>
                </section>}
                {task.appMemoryUnavailable && <p role="status">
                  The application memory used by this task is unavailable. Restore access to the original source and version to retry.
                </p>}
                {task.personalMemoryUnavailable && <p role="status">
                  The personal memory used by this task is unavailable. Create a new task with the current memory.
                </p>}
                {memoryUnavailable && <button type="button" disabled={busy} onClick={startDraftFromTask}>
                  Create new task from this goal
                </button>}
                {task.waitingForPreviousRun && <p role="status">Waiting for the previous run to stop before retrying.</p>}
                {progress && <p role="status">{progress.message}</p>}
                {task.result && <pre id="task-outcome" tabIndex={-1}>{task.result}</pre>}
                {task.usesAppMemory && <section aria-label="Paired phone result access">
                  <button disabled={busy} onClick={() => submit(async () => {
                    const data = await api('/tasks/' + task.id + '/share-result');
                    setPhoneGrants({ taskId: task.id, clients: data.clients });
                  })}>{t('Manage phone access', '管理手机访问')}</button>
                  {phoneGrants?.taskId === task.id && phoneGrants.clients.length === 0 && <p>No paired phones.</p>}
                  {phoneGrants?.taskId === task.id && phoneGrants.clients.map(phone => (
                    <div key={phone.id}>
                      <span>{phone.name}</span>
                      {phone.version !== task.version && <button disabled={busy || !task.result || task.status !== 'succeeded'}
                        onClick={() => submit(async () => {
                          const data = await api('/tasks/' + task.id + '/share-result', {
                            method: 'POST', body: { clientId: phone.id, expectedVersion: task.version, enabled: true },
                          });
                          setPhoneGrants({ taskId: task.id, clients: data.clients });
                        })}>Share this version</button>}
                      {phone.version != null && <button disabled={busy} onClick={() => submit(async () => {
                        const data = await api('/tasks/' + task.id + '/share-result', {
                          method: 'POST', body: { clientId: phone.id, enabled: false },
                        });
                        setPhoneGrants({ taskId: task.id, clients: data.clients });
                      })}>Revoke access</button>}
                    </div>
                  ))}
                </section>}
                {task.status === 'succeeded' && task.result && !task.usesAppMemory && !task.usesPersonalMemory && !/^\/(observe|click) /.test(task.goal) && (
                  <button disabled={busy || (savedResult?.id === task.id && savedResult?.version === task.version)}
                    onClick={() => submit(async () => {
                      await api('/tasks/' + task.id + '/remember-result', { method: 'POST', body: { expectedVersion: task.version } });
                      setSavedResult({ id: task.id, version: task.version });
                    })}>
                    {savedResult?.id === task.id && savedResult?.version === task.version ? 'Saved to memory' : 'Save result to memory'}
                  </button>
                )}
                {taskApprovals.map(item => (
                  <section className="approval" id={'approval-' + item.id} tabIndex={-1} key={item.id}>
                    <h3>{t('Approval required', '需要批准')}</h3>
                    <p>{item.summary}</p>
                    <button disabled={busy} onClick={() => command('approve', { approvalId: item.id })}>{t('Approve', '批准')}</button>
                    <button disabled={busy} onClick={() => command('deny', { approvalId: item.id })}>{t('Deny', '拒绝')}</button>
                  </section>
                ))}
                {taskAttachments.length > 0 && <section aria-label={t('Input attachments', '输入附件')}>
                  <h3>{t('Input attachments', '输入附件')}</h3>
                  <ul>{taskAttachments.map(item => <li key={item.position}>
                    <button disabled={busy} onClick={() => submit(async () => {
                      const file = await api('/tasks/' + task.id + '/attachments/' + item.position);
                      setPreview({ taskId: task.id, attachmentPosition: item.position, name: file.name, text: file.text });
                    })}>{item.name}</button> · {item.size} bytes
                  </li>)}</ul>
                </section>}
                {artifacts.map(item => {
                  const latest = artifacts.find(file => file.name === item.name && file.mime === item.mime);
                  const hasOlderVersion = artifacts.some(file => file.id !== item.id && file.name === item.name && file.mime === item.mime);
                  return <div key={item.id}>
                    <button disabled={busy} onClick={() => previewArtifact(item)}>{item.name}{latest?.id === item.id && hasOlderVersion ? ' (latest)' : ''}</button>
                    {latest && latest.id !== item.id && item.name === 'git-changes.json' && <details>
                      <summary>Compare Git snapshot with version {latest.version ?? 'latest'}</summary>
                      <form onSubmit={event => {
                        event.preventDefault();
                        const repository = String(new FormData(event.currentTarget).get('repository')).trim();
                        submit(async () => {
                          const { patch } = await api('/artifacts/' + latest.id + '/git-compare', {
                            method: 'POST', body: { base: item.id, repository },
                          });
                          setPreview({ taskId: item.taskId, artifactIds: [item.id, latest.id],
                            name: 'Git changes from version ' + item.version + ' to ' + latest.version,
                            gitPatch: patch, text: 'The snapshots have identical file contents.' });
                        });
                      }}>
                        <label>Repository path on the Router Mac<input name="repository" required /></label>
                        <button disabled={busy}>Compare snapshots</button>
                      </form>
                    </details>}
                    {latest && latest.id !== item.id && !item.mime && item.name !== 'git-changes.json' && <button disabled={busy} onClick={() => submit(async () => {
                      const diff = await api('/artifacts/' + latest.id + '/diff?base=' + item.id);
                      setPreview({ taskId: item.taskId, artifactIds: [item.id, latest.id], name: 'Changes from ' + item.name, text: diff.text, diff: true });
                    })}>Compare with latest</button>}
                  </div>;
                })}
                {(task.status === 'waiting_review' || task.desktopReconciliationRequired) && <section className="approval" id="result-review" tabIndex={-1} aria-label={t('Result review', '结果验收')}>
                  <h3>{t('Review result', '验收结果')}</h3>
                  {reviewArtifact && <button type="button" disabled={busy} onClick={() => previewArtifact(reviewArtifact)}>{t('Review code changes', '审阅代码变更')}</button>}
                  <button className="primary" disabled={busy} onClick={() => command('accept_result')}>{task.desktopReconciliationRequired ? 'Confirm click took effect' : 'Accept result'}</button>
                  <button disabled={busy} onClick={() => command('reject_result')}>{task.desktopReconciliationRequired ? 'Confirm click did not take effect' : 'Reject result'}</button>
                </section>}
                <ChannelLinks key={'links:' + task.id} taskId={task.id} token={connected} cursor={snapshot.cursor} />
                {!memoryUnavailable && <details id="task-activity" tabIndex={-1} className="task-activity" key={'timeline:' + task.id}
                  open={task.status === 'running' || undefined}>
                  <summary>{t('Activity', '执行记录')}</summary>
                  <Timeline taskId={task.id} token={connected} cursor={snapshot.cursor}
                    reviewWiki={id => { setWikiReviewId(id); setSettings('wiki'); }} />
                </details>}
                {!task.desktopReconciliationRequired && ['queued', 'running', 'waiting_user', 'waiting_dependency', 'waiting_device'].includes(task.status) &&
                  <button disabled={busy} onClick={() => command('pause')}>{t('Pause task', '暂停任务')}</button>}
                {task.status === 'paused' &&
                  <button disabled={busy || memoryUnavailable} onClick={() => command('resume')}>{t('Resume task', '恢复任务')}</button>}
                {(task.status === 'failed' || (task.status === 'waiting_user' && !task.desktopReconciliationRequired
                  && !snapshot.approvals.some(approval => approval.taskId === task.id))) &&
                  <button id="retry-task" disabled={busy || memoryUnavailable} onClick={() => {
                    if (window.confirm('Retry this task as a new run? Review any effects of the previous run first.')) command('retry');
                  }}>{t('Retry task', '重试任务')}</button>}
                {task.status === 'failed' && workflowId && !memoryUnavailable && <div>
                  {retryWorkers === null ? <button type="button" disabled={busy} onClick={() => submit(async () => {
                    const { workers } = await api('/tasks/' + task.id + '/retry-workers');
                    setRetryWorkers({ taskId: task.id, workers: workers.filter(worker => worker.id !== configuredWorker) });
                  })}>{t('Find another Worker', '查找其他 Worker')}</button> : retryWorkers.taskId === task.id && (retryWorkers.workers.length
                    ? <form onSubmit={event => {
                      event.preventDefault();
                      if (retryDevice) command('retry_on_worker', { deviceId: retryDevice });
                    }}>
                      <label>Retry with Worker<select required value={retryDevice}
                        onChange={event => setRetryDevice(event.target.value)}>
                        <option value="">{t('Select a Worker', '选择 Worker')}</option>
                        {retryWorkers.workers.map(worker =>
                          <option key={worker.id} value={worker.id}>{worker.name} · {worker.label}{worker.online ? '' : ' · Offline'}</option>)}
                      </select></label>
                      <button disabled={busy || !retryDevice}>{t('Reassign and retry', '重新分配并重试')}</button>
                    </form> : <p>No compatible Workers are registered in this workspace.</p>)}
                </div>}
                {['paused', 'pausing', 'waiting_review', 'queued', 'running', 'waiting_user', 'waiting_dependency', 'waiting_device'].includes(task.status) &&
                  <button disabled={busy} onClick={() => command('cancel')}>{t('Cancel task', '取消任务')}</button>}
                {!['cancelled', 'cancelling', 'paused', 'pausing'].includes(task.status) && (
                  <details className="task-instructions">
                    <summary>Change instructions</summary>
                    <form className="task-follow-up" onSubmit={event => {
                    event.preventDefault();
                    if (!memoryUnavailable) command('append', { text: instruction });
                  }}>
                      <label>{t('Additional instructions', '补充指令')}<textarea disabled={memoryUnavailable} value={instruction} onChange={event => setInstruction(event.target.value)} required /></label>
                      <button disabled={busy || memoryUnavailable || !instruction.trim()}>{t('Apply instruction', '应用指令')}</button>
                    </form>
                  </details>
                )}
              </section>
            )}
              {!task && <section className="workspace-compose" aria-labelledby="brief-title">
              <PageHeading title="New task" id="brief-title"
                description={t('Define the outcome and attach the context the Agent should use.', '写下要交付的结果，添加 Agent 执行时需要的上下文。')} />
              <form className="task-composer" onSubmit={event => {
                event.preventDefault();
                const action = event.nativeEvent.submitter?.value;
                const ask = action === 'ask';
                submit(async () => {
                  setMemoryAnswer(null);
                  setFollowUp(null);
                  if (action === 'app-memory') {
                    if (!chosenSources.length || !memoryQuery.trim()) return;
                    setPlan(null);
                    setAnswer('');
                    setMemoryAnswer(await api('/memory/answer', { method: 'POST', body: {
                      workspace, question: goal, query: memoryQuery, sources: chosenSources.map(account => account.id),
                      includePersonal: usePersonalMemory,
                    } }));
                    return;
                  }
                  const appMemory = action === 'app-task' ? {
                    query: memoryQuery, sources: chosenSources.map(account => account.id),
                  } : undefined;
                  const result = await api(ask ? '/conversation' : '/events', {
                    method: 'POST', key, body: { workspace, text: goal, usePersonalMemory, appMemory,
                      ...(!ask && attachments.length > 0 && { attachments }),
                      ...(!ask && copiedFromTask && { copiedFromTask: copiedFromTask.id }),
                    },
                  });
                  if (ask) {
                    const thread = workspace.trim();
                    setConversation(previous => ({ ...previous, [thread]: [
                      ...(previous[thread] ?? []).filter(turn => turn.id !== key),
                      { id: key, text: goal, reply: result.text ?? 'Task created.', taskId: result.task?.id },
                    ].slice(-50) }));
                    setGoal('');
                    setKey(crypto.randomUUID());
                  }
                  if (ask && result.kind !== 'create_task') {
                    setAnswer(result.text);
                    if (result.kind === 'append_task') setFollowUp({ ...result, key: crypto.randomUUID() });
                    setPlan(result.kind === 'propose_workflow'
                      ? { workspace, steps: result.steps, proposalKey: result.proposalKey, key: crypto.randomUUID() } : null);
                    return;
                  }
                  const created = ask ? result.task : result;
                  setAnswer('');
                  setPlan(null);
                  setGoal('');
                  setCopiedFromTask(null);
                  setAttachments([]);
                  setKey(crypto.randomUUID());
                  setSelected(created.id);
                  setBriefOpen(false);
                  await reload();
                });
              }}>
                {copiedFromTask && <p>{copiedFromTask.requiresAppMemory
                  ? 'Goal copied from an application-backed task. Select current app sources to create the new task.'
                  : 'Goal copied from another task. Select any current memory sources to include.'}</p>}
                <div className="composer-workspace"><label>{t('Workspace', '工作区')}<input value={workspace} readOnly={Boolean(copiedFromTask)} onChange={event => {
                  setWorkspace(event.target.value);
                  setMemorySources([]);
                  setMemoryAnswer(null);
                  setKey(crypto.randomUUID());
                }} required /></label></div>
                <label className="composer-message">{t('Goal', '任务目标')}<textarea placeholder={t('Describe the result you want to verify', '描述你希望验收的结果')} value={goal} onChange={event => {
                  setGoal(event.target.value);
                  setMemoryAnswer(null);
                  setKey(crypto.randomUUID());
                }} required /></label>
                <div className="composer-actions">
                <label className="desktop-button composer-attachment"><DesktopIcon name="attachment" /> {t('Attach', '添加附件')}<input className="visually-hidden" aria-label={t('Attach text files', '添加文本文件')} type="file" accept=".txt,.md,.csv,.json,.log,text/*" multiple disabled={busy}
                  onChange={event => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = '';
                    if (!files.length) return;
                    submit(async () => {
                      setAttachments(await readTaskFiles(files));
                      setKey(crypto.randomUUID());
                    });
                  }} /></label>
                </div>
                {attachments.length > 0 && <ul aria-label={t('Selected attachments', '已选附件')}>{attachments.map((attachment, index) =>
                  <li key={index}>{attachment.name}{' '}
                    <button type="button" disabled={busy} aria-label={'Remove ' + attachment.name} onClick={() => {
                      setAttachments(items => items.filter((_, position) => position !== index));
                      setKey(crypto.randomUUID());
                    }}>{t('Remove', '移除')}</button>
                  </li>)}</ul>}
                {copiedFromTask && <button type="button" disabled={busy} onClick={() => {
                  setCopiedFromTask(null);
                  setGoal('');
                  setAttachments([]);
                  setMemorySources([]);
                  setMemoryQuery('');
                  setKey(crypto.randomUUID());
                }}>{t('Discard copied draft', '放弃复制的草稿')}</button>}
                <label className="brief-memory" data-selected={usePersonalMemory}>
                  <DesktopIcon name="agent" />
                  <span><strong>{t('Include personal memory', '使用个人记忆')}</strong>
                    <small id="brief-memory-description">{t('Use your saved notes and preferences as task context.', '让 Agent 使用你保存的笔记和偏好作为任务上下文。')}</small></span>
                  <input type="checkbox" aria-label={t('Include personal memory', '使用个人记忆')}
                    aria-describedby="brief-memory-description" checked={usePersonalMemory} onChange={event => {
                  setUsePersonalMemory(event.target.checked);
                  setKey(crypto.randomUUID());
                }} /></label>
                <div className="composer-actions brief-submit">
                <button className="primary" type="submit" value="create" disabled={busy || copiedFromTask?.requiresAppMemory || !workspace.trim() || !goal.trim()}>{t('Queue task', '加入队列')}</button>
                <button type="submit" value="ask" disabled={busy || Boolean(copiedFromTask) || attachments.length > 0 || !workspace.trim() || !goal.trim()}>{t('Route with Blazar', '让 Agent 拆解')}</button>
                </div>
                {availableSources.length > 0 && <details>
                  <summary>{t('Ask with app memory', '使用应用记忆')}</summary>
                  <label>{t('Search terms', '搜索关键词')}<input value={memoryQuery} maxLength={256} onChange={event => {
                    setMemoryQuery(event.target.value);
                    setMemoryAnswer(null);
                    setKey(crypto.randomUUID());
                  }} /></label>
                  {availableSources.map(account => <label className="checkbox-label" key={account.id}>
                    <input type="checkbox" checked={memorySources.includes(account.id)} onChange={event => {
                      setMemorySources(event.target.checked ? [...memorySources, account.id] :
                        memorySources.filter(id => id !== account.id));
                      setMemoryAnswer(null);
                      setKey(crypto.randomUUID());
                    }} /> {account.app} · {account.account}
                  </label>)}
                  <button type="submit" value="app-memory" disabled={busy || Boolean(copiedFromTask) || attachments.length > 0 || !goal.trim() || goal.trim().length > 4000 ||
                    !memoryQuery.trim() || !chosenSources.length || chosenSources.length > 25}>{t('Ask with selected apps', '向选定应用提问')}</button>
                  <button type="submit" value="app-task" disabled={busy || !goal.trim() ||
                    !memoryQuery.trim() || !chosenSources.length || chosenSources.length > 25}>{t('Create task with selected apps', '使用选定应用创建任务')}</button>
                </details>}
                {memoryAnswer && <section aria-label={t('Answer from app memory', '应用记忆的回答')}>
                  <p role="status">{memoryAnswer.answer ?? 'No matching memories.'}</p>
                  <ul>{memoryAnswer.sources.map(source => {
                    const account = chosenSources.find(item => item.id === source.connection);
                    return <li key={source.id}>{account ? account.app + ' · ' + account.account + ' · ' + source.resource : 'Personal note'}</li>;
                  })}</ul>
                </section>}
                {answer && !plan && !followUp && <section className="approval" aria-label={t('Routing response', 'Agent 分析')}><h3>{t('Routing response', 'Agent 分析')}</h3><p className="conversation-reply" role="status">{answer}</p></section>}
                {followUp && <section className="approval" aria-label={t('Proposed follow-up', '后续操作建议')}>
                  <h3>{t('Proposed follow-up', '后续操作建议')}</h3>
                  <p>{snapshot.tasks.find(item => item.id === followUp.taskId)?.goal ?? followUp.taskId}</p>
                  <p>{followUp.instruction}</p>
                  <button type="button" disabled={busy} onClick={() => submit(async () => {
                    await api('/tasks/' + followUp.taskId + '/commands', {
                      method: 'POST', key: followUp.key,
                      body: { action: 'append', text: followUp.instruction, expectedVersion: followUp.expectedVersion },
                    });
                    setSelected(followUp.taskId);
                    setBriefOpen(false);
                    setFollowUp(null);
                    setAnswer('');
                    await reload();
                  })}>{t('Apply instruction', '应用指令')}</button>
                  <button type="button" disabled={busy} onClick={() => { setFollowUp(null); setAnswer(''); }}>Discard</button>
                </section>}
                {plan && <section className="approval" aria-label={t('Proposed workflow', '建议的工作流')}>
                  <h3>{t('Proposed workflow', '建议的工作流')}</h3>
                  <p>Workspace: {plan.workspace}</p>
                  {workflowAgentError && <p role="alert">{workflowAgentError}</p>}
                  <ol>{plan.steps.map(step => <li key={step.key}>
                    <strong>{step.key}</strong> · {step.goal}
                    {step.action && <p>{step.action.kind === 'desktop.click'
                      ? `Click ${step.action.button} in ${step.action.alias}, window ${step.action.windowFrom?.title ?? step.action.windowId}`
                      : step.action.kind === 'desktop.write'
                      ? `Set ${step.action.field} in ${step.action.alias}, window ${step.action.windowFrom.title} to ${JSON.stringify(step.action.value)}`
                      : `${step.action.mode === 'windows' ? 'List windows for' : step.action.mode === 'visual' ? 'Capture screenshot of' : step.action.mode === 'hybrid' ? 'Observe and capture' : 'Observe'} ${step.action.alias}${step.action.windowFrom ? `, window ${step.action.windowFrom.title}` : ''}`} on device {step.action.deviceId}</p>}
                    {step.outputArtifact && <p>Required output {step.outputArtifact}</p>}
                    {step.inputArtifacts && <ul aria-label="Named input artifacts">{Object.entries(step.inputArtifacts).map(([source, filename]) =>
                      <li key={source}>{filename} from {source}</li>)}</ul>}
                    {step.runLimitSeconds && <p>Time limit: {step.runLimitSeconds} seconds</p>}
                    {step.workerCapability && <p>Requires {({ steer: 'live instructions', 'full-input-artifacts': 'full input artifacts', 'git-worktree': 'an isolated Git checkout', 'writable-worktree': 'an isolated writable Git checkout', 'git-patch-inputs': 'applying predecessor Git patches in an isolated checkout', 'read-only': 'a read-only Worker', 'offline-tools': 'a Worker with tool network access disabled' })[step.workerCapability] ?? step.workerCapability}</p>}
                    {!step.action && !step.goal.startsWith('/preview ') && <label>
                      Execution Agent
                      <select value={agentAssignments[step.key] ?? ''} disabled={busy}
                        onChange={event => {
                          const id = event.target.value;
                          setAgentAssignments(current => {
                            const next = { ...current };
                            if (id) next[step.key] = id;
                            else delete next[step.key];
                            return next;
                          });
                        }}>
                        <option value="">{step.workerDeviceId
                          ? 'Proposed · ' + (workflowAgents.find(device => device.id === step.workerDeviceId)?.name ?? step.workerDeviceId)
                          : 'Assign automatically'}</option>
                        {workflowAgents.filter(device => device.workspace === plan.workspace &&
                          device.workerProtocol && !device.revoked && !device.paused && !device.workerPolicyBlocked &&
                          (!step.workerProtocols || step.workerProtocols.includes(device.workerProtocol)) &&
                          (!step.workerCapability || JSON.parse(device.workerCapabilities ?? '[]').includes(step.workerCapability)))
                          .map(device => <option key={device.id} value={device.id}>
                            {device.name} · {device.workerLabel}{device.online ? '' : ' · Offline'}
                          </option>)}
                      </select>
                    </label>}
                    {step.workerProtocols?.length > 0 && <p>Worker protocols: {step.workerProtocols.join(', ')}</p>}
                    {step.action?.expectedText && <p>Expected text: {step.action.expectedText}
                      {step.action.waitSeconds && ` (wait up to ${step.action.waitSeconds} seconds)`}</p>}
                    {step.acceptanceCriteria?.length > 0 && <ul>{step.acceptanceCriteria.map(criterion =>
                      <li key={criterion}>{criterion}</li>)}</ul>}
                    {step.requireReview && <p>Requires your acceptance</p>}
                    {step.needs.length > 0 && <p>After {step.needs.join(', ')}</p>}
                  </li>)}</ol>
                  <button type="button" disabled={busy} onClick={() => createWorkflow()}>Create workflow</button>
                  {plan.workspace === workspace && chosenSources.length > 0 && chosenSources.length <= 25 && memoryQuery.trim() &&
                    <button type="button" disabled={busy} onClick={() => createWorkflow({
                      query: memoryQuery, sources: chosenSources.map(account => account.id),
                    })}>Create workflow with selected apps</button>}
                  <button type="button" disabled={busy} onClick={() => { setPlan(null); setAnswer(''); }}>Discard plan</button>
                </section>}
              </form>
              </section>}
              {linkedTurns.length > 0 && (
            <details className="assistant-conversation" id="workspace-conversation" tabIndex={-1} aria-label="Planning history">
              <summary>Planning history</summary>
              {linkedTurns.length > 0 && <ol aria-live="polite">{linkedTurns.map(turn => {
                const linkedTask = snapshot?.tasks.find(item => item.id === turn.taskId);
                return <li key={turn.id} id={'conversation-' + turn.id} tabIndex={-1}>
                <div className="assistant-user"><strong>You</strong><p>{turn.text}</p></div>
                <div><strong>Blazar</strong><p>{turn.reply}</p></div>
                {linkedTask && <button type="button" onClick={() => openTask(linkedTask)}>
                  Open task · {desktopStatus(t, linkedTask.status)}
                </button>}
              </li>;
              })}</ol>}
            </details>
              )}
          </section>
          {visiblePreview && <ArtifactPreview key={preview.artifactIds?.join(':') ?? preview.attachmentPosition} preview={preview}
            canExport={preview.artifactIds?.length === 1 && task.status === 'succeeded' && artifacts.some(item =>
              item.id === preview.artifactIds?.[0] && item.version === task.version)}
            deliver={async (details, action) => {
              const path = '/artifacts/' + preview.artifactIds[0] + '/git-delivery' + (action ? '/' + action : '');
              const result = await api(path, {
                method: 'POST', body: { ...details, expectedVersion: task.version },
              });
              await reload();
              return result;
            }} close={() => setPreview(null)} />}
        </div>
      )}
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<DesktopLanguage><App /></DesktopLanguage>);
