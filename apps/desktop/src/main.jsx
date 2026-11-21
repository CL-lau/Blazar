import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PairingCode } from './PairingCode.jsx';
import { Timeline } from './Timeline.jsx';
import { Knowledge } from './Knowledge.jsx';
import { ChannelLinks } from './ChannelLinks.jsx';
import { DesktopControl } from './DesktopControl.jsx';
import { Devices } from './Devices.jsx';
import { RouterStatus } from './RouterStatus.jsx';
import { callRouter } from './router.js';
import './style.css';

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

function App() {
  const [token, setToken] = useState('');
  const [connected, setConnected] = useState('');
  const [localRouter, setLocalRouter] = useState('checking');
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
  const [pairing, setPairing] = useState(null);
  const [clients, setClients] = useState([]);
  const [pairingRequests, setPairingRequests] = useState([]);

  useEffect(() => {
    if (connected) return;
    const stop = new AbortController();
    let timer;
    async function check() {
      try {
        const health = await callRouter('', '/health', { signal: stop.signal });
        if (!stop.signal.aborted) setLocalRouter(
          health?.service === 'blazar-router' && health.status === 'ready' ? 'ready' : 'unavailable');
      } catch {
        if (!stop.signal.aborted) setLocalRouter('unavailable');
      } finally {
        if (!stop.signal.aborted) timer = setTimeout(check, 5_000);
      }
    }
    void check();
    return () => { stop.abort(); clearTimeout(timer); };
  }, [connected]);

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

  const task = snapshot?.tasks.find(item => item.id === selected);
  const memoryUnavailable = task?.appMemoryUnavailable || task?.personalMemoryUnavailable;
  const dependencies = (snapshot?.workflowSteps ?? [])
    .filter(link => link.taskId === selected && link.predecessorId)
    .map(link => snapshot.tasks.find(item => item.id === link.predecessorId)).filter(Boolean);
  const artifacts = snapshot?.artifacts.filter(item => item.taskId === selected) ?? [];
  const taskAttachments = snapshot?.attachments?.filter(item => item.taskId === selected) ?? [];
  const criteria = snapshot?.criteria?.filter(item => item.taskId === selected) ?? [];
  const progress = snapshot?.progress?.find(item => item.taskId === selected);
  const availableSources = memoryAccounts.filter(account =>
    account.active && (!account.workspace || account.workspace === workspace.trim()));
  const chosenSources = availableSources.filter(account => memorySources.includes(account.id));
  const api = (path, options) => callRouter(connected, path, options);
  const createWorkflow = appMemory => submit(async () => {
    const created = await api('/workflows', {
      method: 'POST', key: plan.key, body: { workspace: plan.workspace, steps: plan.steps, proposalKey: plan.proposalKey, appMemory },
    });
    setSelected(created.steps[0].taskId);
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
  }
  const reload = () => refreshSnapshot(connected);
  const command = (action, extra = {}) => submit(async () => {
    await api(`/tasks/${task.id}/commands`, {
      method: 'POST', key: crypto.randomUUID(), body: { action, expectedVersion: task.version, ...extra },
    });
    setInstruction('');
    await reload();
  });

  return (
    <main>
      <header>
        <h1>Blazar</h1>
        {connected && (
          <nav aria-label="Workspace views">
            <button onClick={() => setSettings('tasks')}>Tasks</button>
            <button onClick={() => { setMemoryAnswer(null); setPreview(null); setSettings('knowledge'); }}>Apps and memory</button>
            <button onClick={() => setSettings('devices')}>Execution devices</button>
            <button onClick={() => setSettings('desktop-control')}>Desktop control</button>
            <button onClick={() => setSettings('router-status')}>Router status</button>
            <button onClick={() => submit(async () => {
              setClients((await api('/admin/mobile-clients')).clients);
              setSettings('phones');
            })}>Linked phones</button>
          </nav>
        )}
      </header>
      {(error || syncError) && <p className="error" role="alert">{error || syncError}</p>}
      {!connected ? (
        <form className="connect" onSubmit={event => {
          event.preventDefault();
          submit(async () => {
            setSnapshot(await callRouter(token, '/state'));
            setConnected(token);
            setToken('');
          });
        }}>
          <h2>Connect to your Router</h2>
          <p role="status">{{
            checking: 'Checking the local Router…',
            ready: 'The local Router is ready.',
            unavailable: 'The local Router is unavailable. Start the Router service, then try again.',
          }[localRouter]}</p>
          <label>Access token<input type="password" value={token} onChange={event => setToken(event.target.value)} required /></label>
          <button className="primary" disabled={busy}>Connect</button>
        </form>
      ) : settings === 'knowledge' ? (
        <Knowledge token={connected} />
      ) : settings === 'devices' ? (
        <Devices token={connected} />
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
        <section className="detail">
          <h2>Linked phones</h2>
          <button className="primary" disabled={busy} onClick={() => submit(async () => {
            setPairing(await api('/pairings', { method: 'POST' }));
          })}>Create pairing code</button>
          {pairing && <PairingCode key={pairing.code} pairing={pairing} />}
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
      ) : (
        <div className="workspace">
          <aside aria-label="Tasks">
            <h2>Tasks</h2>
            <button className="primary" onClick={() => { setSelected(''); setPreview(null); }}>New task</button>
            <ul>{snapshot?.tasks.map(item => (
              <li key={item.id}><button className="task-link" aria-current={item.id === selected ? 'true' : undefined}
                onClick={() => { setSelected(item.id); setInstruction(''); setPreview(null); }}>
                <span>{item.goal}</span><small>{item.status.replaceAll('_', ' ')}</small>
              </button></li>
            ))}</ul>
          </aside>
          <section className="detail">
            {task ? (
              <>
                <h2>{task.goal}</h2>
                <p className="status">{task.status.replaceAll('_', ' ')}</p>
                {dependencies.length > 0 && <section aria-label="Dependencies">
                  <h3>Dependencies</h3>
                  <ul>{dependencies.map(item => <li key={item.id}>
                    <button type="button" onClick={() => { setSelected(item.id); setInstruction(''); setPreview(null); }}>
                      {item.goal} · {item.status.replaceAll('_', ' ')}
                    </button>
                  </li>)}</ul>
                </section>}
                {criteria.length > 0 && <section aria-label="Acceptance criteria">
                  <h3>Acceptance criteria</h3>
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
                {task.result && <pre>{task.result}</pre>}
                {task.usesAppMemory && <section aria-label="Paired phone result access">
                  <button disabled={busy} onClick={() => submit(async () => {
                    const data = await api('/tasks/' + task.id + '/share-result');
                    setPhoneGrants({ taskId: task.id, clients: data.clients });
                  })}>Manage phone access</button>
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
                {snapshot.approvals.filter(item => item.taskId === task.id).map(item => (
                  <section className="approval" key={item.id}>
                    <h3>Approval required</h3>
                    <p>{item.summary}</p>
                    <button disabled={busy} onClick={() => command('approve', { approvalId: item.id })}>Approve</button>
                    <button disabled={busy} onClick={() => command('deny', { approvalId: item.id })}>Deny</button>
                  </section>
                ))}
                {taskAttachments.length > 0 && <section aria-label="Input attachments">
                  <h3>Input attachments</h3>
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
                    <button disabled={busy} onClick={() => submit(async () => {
                      if (item.mime === 'image/png') {
                        const { png } = await api('/artifacts/' + item.id + '/image');
                        setPreview({ taskId: item.taskId, artifactIds: [item.id], name: item.name, png, expires: item.expires });
                      } else {
                        setPreview({ taskId: item.taskId, artifactIds: [item.id], name: item.name, text: await api('/artifacts/' + item.id) });
                      }
                    })}>{item.name}{latest?.id === item.id && hasOlderVersion ? ' (latest)' : ''}</button>
                    {latest && latest.id !== item.id && !item.mime && <button disabled={busy} onClick={() => submit(async () => {
                      const diff = await api('/artifacts/' + latest.id + '/diff?base=' + item.id);
                      setPreview({ taskId: item.taskId, artifactIds: [item.id, latest.id], name: 'Changes from ' + item.name, text: diff.text });
                    })}>Compare with latest</button>}
                  </div>;
                })}
                {preview?.taskId === task.id && (preview.attachmentPosition === undefined
                  ? preview.artifactIds.every(id => artifacts.some(item => item.id === id))
                  : taskAttachments.some(item => item.position === preview.attachmentPosition)) &&
                  <section><h3>{preview.name}</h3>
                  {preview.png ? <img className="window-image" src={'data:image/png;base64,' + preview.png} alt="Captured window" /> :
                    <pre>{preview.text}</pre>}
                </section>}
                {(task.status === 'waiting_review' || task.desktopReconciliationRequired) && <section className="approval" aria-label="Result review">
                  <h3>Review result</h3>
                  <button disabled={busy} onClick={() => command('accept_result')}>{task.desktopReconciliationRequired ? 'Confirm click took effect' : 'Accept result'}</button>
                  <button disabled={busy} onClick={() => command('reject_result')}>{task.desktopReconciliationRequired ? 'Confirm click did not take effect' : 'Reject result'}</button>
                </section>}
                <ChannelLinks key={'links:' + task.id} taskId={task.id} token={connected} cursor={snapshot.cursor} />
                {!memoryUnavailable && <Timeline key={'timeline:' + task.id} taskId={task.id} token={connected} cursor={snapshot.cursor} />}
                {!task.desktopReconciliationRequired && ['queued', 'running', 'waiting_user', 'waiting_dependency', 'waiting_device'].includes(task.status) &&
                  <button disabled={busy} onClick={() => command('pause')}>Pause task</button>}
                {task.status === 'paused' &&
                  <button disabled={busy || memoryUnavailable} onClick={() => command('resume')}>Resume task</button>}
                {(task.status === 'failed' || (task.status === 'waiting_user' && !task.desktopReconciliationRequired
                  && !snapshot.approvals.some(approval => approval.taskId === task.id))) &&
                  <button disabled={busy || memoryUnavailable} onClick={() => {
                    if (window.confirm('Retry this task as a new run? Review any effects of the previous run first.')) command('retry');
                  }}>Retry task</button>}
                {['paused', 'pausing', 'waiting_review'].includes(task.status) &&
                  <button disabled={busy} onClick={() => command('cancel')}>Cancel task</button>}
                {!['cancelled', 'cancelling', 'paused', 'pausing'].includes(task.status) && (
                  <form onSubmit={event => {
                    event.preventDefault();
                    if (!memoryUnavailable) command('append', { text: instruction });
                  }}>
                    <label>Follow-up<textarea disabled={memoryUnavailable} value={instruction} onChange={event => setInstruction(event.target.value)} required /></label>
                    <button disabled={busy || memoryUnavailable || !instruction.trim()}>Send instruction</button>
                    {['queued', 'running', 'waiting_user', 'waiting_dependency', 'waiting_device'].includes(task.status) &&
                      <button type="button" disabled={busy} onClick={() => command('cancel')}>Cancel task</button>}
                  </form>
                )}
              </>
            ) : (
              <form onSubmit={event => {
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
                  await reload();
                });
              }}>
                <h2>New task</h2>
                {copiedFromTask && <p>{copiedFromTask.requiresAppMemory
                  ? 'Goal copied from an application-backed task. Select current app sources to create the new task.'
                  : 'Goal copied from another task. Select any current memory sources to include.'}</p>}
                <label>Workspace<input value={workspace} readOnly={Boolean(copiedFromTask)} onChange={event => {
                  setWorkspace(event.target.value);
                  setMemorySources([]);
                  setMemoryAnswer(null);
                  setKey(crypto.randomUUID());
                }} required /></label>
                <label>Task<textarea value={goal} onChange={event => {
                  setGoal(event.target.value);
                  setMemoryAnswer(null);
                  setKey(crypto.randomUUID());
                }} required /></label>
                <label>Attach text files<input type="file" accept=".txt,.md,.csv,.json,.log,text/*" multiple disabled={busy}
                  onChange={event => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = '';
                    if (!files.length) return;
                    submit(async () => {
                      setAttachments(await readTaskFiles(files));
                      setKey(crypto.randomUUID());
                    });
                  }} /></label>
                {attachments.length > 0 && <ul aria-label="Selected attachments">{attachments.map((attachment, index) =>
                  <li key={index}>{attachment.name}{' '}
                    <button type="button" disabled={busy} aria-label={'Remove ' + attachment.name} onClick={() => {
                      setAttachments(items => items.filter((_, position) => position !== index));
                      setKey(crypto.randomUUID());
                    }}>Remove</button>
                  </li>)}</ul>}
                <button className="primary" disabled={busy || copiedFromTask?.requiresAppMemory || !workspace.trim() || !goal.trim()}>Create task</button>
                {copiedFromTask && <button type="button" disabled={busy} onClick={() => {
                  setCopiedFromTask(null);
                  setGoal('');
                  setAttachments([]);
                  setMemorySources([]);
                  setMemoryQuery('');
                  setKey(crypto.randomUUID());
                }}>Discard copied draft</button>}
                <label className="checkbox-label"><input type="checkbox" checked={usePersonalMemory} onChange={event => {
                  setUsePersonalMemory(event.target.checked);
                  setKey(crypto.randomUUID());
                }} /> Include personal memory</label>
                <button type="submit" value="ask" disabled={busy || Boolean(copiedFromTask) || attachments.length > 0 || !workspace.trim() || !goal.trim()}>Ask Blazar</button>
                {availableSources.length > 0 && <details>
                  <summary>Ask with app memory</summary>
                  <label>Search terms<input value={memoryQuery} maxLength={256} onChange={event => {
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
                    !memoryQuery.trim() || !chosenSources.length || chosenSources.length > 25}>Ask with selected apps</button>
                  <button type="submit" value="app-task" disabled={busy || !goal.trim() ||
                    !memoryQuery.trim() || !chosenSources.length || chosenSources.length > 25}>Create task with selected apps</button>
                </details>}
                {memoryAnswer && <section aria-label="Answer from app memory">
                  <p role="status">{memoryAnswer.answer ?? 'No matching memories.'}</p>
                  <ul>{memoryAnswer.sources.map(source => {
                    const account = chosenSources.find(item => item.id === source.connection);
                    return <li key={source.id}>{account ? account.app + ' · ' + account.account + ' · ' + source.resource : 'Personal note'}</li>;
                  })}</ul>
                </section>}
                {answer && <p className="conversation-reply" role="status">{answer}</p>}
                {followUp && <section className="approval" aria-label="Proposed follow-up">
                  <h3>Proposed follow-up</h3>
                  <p>{snapshot.tasks.find(item => item.id === followUp.taskId)?.goal ?? followUp.taskId}</p>
                  <p>{followUp.instruction}</p>
                  <button type="button" disabled={busy} onClick={() => submit(async () => {
                    await api('/tasks/' + followUp.taskId + '/commands', {
                      method: 'POST', key: followUp.key,
                      body: { action: 'append', text: followUp.instruction, expectedVersion: followUp.expectedVersion },
                    });
                    setSelected(followUp.taskId);
                    setFollowUp(null);
                    setAnswer('');
                    await reload();
                  })}>Send instruction</button>
                  <button type="button" disabled={busy} onClick={() => { setFollowUp(null); setAnswer(''); }}>Discard</button>
                </section>}
                {plan && <section className="approval" aria-label="Proposed workflow">
                  <h3>Proposed workflow</h3>
                  <p>Workspace: {plan.workspace}</p>
                  <ol>{plan.steps.map(step => <li key={step.key}>
                    <strong>{step.key}</strong> · {step.goal}
                    {step.action && <p>{step.action.kind === 'desktop.click'
                      ? `Click ${step.action.button} in ${step.action.alias}, window ${step.action.windowFrom?.title ?? step.action.windowId}`
                      : `${step.action.mode === 'windows' ? 'List windows for' : step.action.mode === 'visual' ? 'Capture screenshot of' : 'Observe'} ${step.action.alias}${step.action.windowFrom ? `, window ${step.action.windowFrom.title}` : ''}`} on device {step.action.deviceId}</p>}
                    {step.outputArtifact && <p>Required output {step.outputArtifact}</p>}
                    {step.inputArtifacts && <ul aria-label="Named input artifacts">{Object.entries(step.inputArtifacts).map(([source, filename]) =>
                      <li key={source}>{filename} from {source}</li>)}</ul>}
                    {step.runLimitSeconds && <p>Time limit: {step.runLimitSeconds} seconds</p>}
                    {step.workerCapability && <p>Requires {({ steer: 'live instructions', 'full-input-artifacts': 'full input artifacts', 'git-worktree': 'an isolated Git checkout', 'git-patch-inputs': 'applying predecessor Git patches in an isolated checkout', 'read-only': 'a read-only Worker', 'offline-tools': 'a Worker with tool network access disabled' })[step.workerCapability] ?? step.workerCapability}</p>}
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
            )}
          </section>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
