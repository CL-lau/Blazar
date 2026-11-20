import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PairingCode } from './PairingCode.jsx';
import { Timeline } from './Timeline.jsx';
import { Knowledge } from './Knowledge.jsx';
import { Devices } from './Devices.jsx';
import { callRouter } from './router.js';
import './style.css';

function App() {
  const [token, setToken] = useState('');
  const [connected, setConnected] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [syncError, setSyncError] = useState('');
  const snapshotSequence = useRef({ requested: 0, applied: 0 });
  const [selected, setSelected] = useState('');
  const [workspace, setWorkspace] = useState('default');
  const [goal, setGoal] = useState('');
  const [usePersonalMemory, setUsePersonalMemory] = useState(false);
  const [answer, setAnswer] = useState('');
  const [plan, setPlan] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [settings, setSettings] = useState('tasks');
  const [pairing, setPairing] = useState(null);
  const [clients, setClients] = useState([]);

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

  async function submit(action) {
    setBusy(true);
    setError('');
    try { await action(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  const task = snapshot?.tasks.find(item => item.id === selected);
  const dependencies = (snapshot?.workflowSteps ?? [])
    .filter(link => link.taskId === selected && link.predecessorId)
    .map(link => snapshot.tasks.find(item => item.id === link.predecessorId)).filter(Boolean);
  const artifacts = snapshot?.artifacts.filter(item => item.taskId === selected) ?? [];
  const progress = snapshot?.progress?.find(item => item.taskId === selected);
  const api = (path, options) => callRouter(connected, path, options);
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
            <button onClick={() => setSettings('knowledge')}>Apps and memory</button>
            <button onClick={() => setSettings('devices')}>Execution devices</button>
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
          <label>Access token<input type="password" value={token} onChange={event => setToken(event.target.value)} required /></label>
          <button className="primary" disabled={busy}>Connect</button>
        </form>
      ) : settings === 'knowledge' ? (
        <Knowledge token={connected} />
      ) : settings === 'devices' ? (
        <Devices token={connected} />
      ) : settings === 'phones' ? (
        <section className="detail">
          <h2>Linked phones</h2>
          <button className="primary" disabled={busy} onClick={() => submit(async () => {
            setPairing(await api('/pairings', { method: 'POST' }));
          })}>Create pairing code</button>
          {pairing && <PairingCode key={pairing.code} pairing={pairing} />}
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
                {progress && <p role="status">{progress.message}</p>}
                {task.result && <pre>{task.result}</pre>}
                {snapshot.approvals.filter(item => item.taskId === task.id).map(item => (
                  <section className="approval" key={item.id}>
                    <h3>Approval required</h3>
                    <p>{item.summary}</p>
                    <button disabled={busy} onClick={() => command('approve', { approvalId: item.id })}>Approve</button>
                    <button disabled={busy} onClick={() => command('deny', { approvalId: item.id })}>Deny</button>
                  </section>
                ))}
                {artifacts.map((item, index) => (
                  <div key={item.id}>
                    <button onClick={() => submit(async () => {
                      setPreview({ taskId: item.taskId, name: item.name, text: await api('/artifacts/' + item.id) });
                    })}>{item.name}{index === 0 && artifacts.length > 1 ? ' (latest)' : ''}</button>
                    {index > 0 && <button onClick={() => submit(async () => {
                      const diff = await api('/artifacts/' + artifacts[0].id + '/diff?base=' + item.id);
                      setPreview({ taskId: item.taskId, name: 'Changes from ' + item.name, text: diff.text });
                    })}>Compare with latest</button>}
                  </div>
                ))}
                {preview?.taskId === task.id && <section><h3>{preview.name}</h3><pre>{preview.text}</pre></section>}
                <Timeline key={task.id} taskId={task.id} token={connected} cursor={snapshot.cursor} />
                {['queued', 'running', 'waiting_user', 'waiting_dependency', 'waiting_device'].includes(task.status) &&
                  <button disabled={busy} onClick={() => command('pause')}>Pause task</button>}
                {task.status === 'paused' &&
                  <button disabled={busy} onClick={() => command('resume')}>Resume task</button>}
                {['paused', 'pausing'].includes(task.status) &&
                  <button disabled={busy} onClick={() => command('cancel')}>Cancel task</button>}
                {!['cancelled', 'cancelling', 'paused', 'pausing'].includes(task.status) && (
                  <form onSubmit={event => { event.preventDefault(); command('append', { text: instruction }); }}>
                    <label>Follow-up<textarea value={instruction} onChange={event => setInstruction(event.target.value)} required /></label>
                    <button disabled={busy || !instruction.trim()}>Send instruction</button>
                    {['queued', 'running', 'waiting_user', 'waiting_dependency', 'waiting_device'].includes(task.status) &&
                      <button type="button" disabled={busy} onClick={() => command('cancel')}>Cancel task</button>}
                  </form>
                )}
              </>
            ) : (
              <form onSubmit={event => {
                event.preventDefault();
                const ask = event.nativeEvent.submitter?.value === 'ask';
                submit(async () => {
                  const result = await api(ask ? '/conversation' : '/events', { method: 'POST', key, body: { workspace, text: goal, ...(ask && { usePersonalMemory }) } });
                  if (ask && result.kind !== 'create_task') {
                    setAnswer(result.text);
                    setPlan(result.kind === 'propose_workflow'
                      ? { workspace, steps: result.steps, key: crypto.randomUUID() } : null);
                    return;
                  }
                  const created = ask ? result.task : result;
                  setAnswer('');
                  setPlan(null);
                  setGoal('');
                  setKey(crypto.randomUUID());
                  setSelected(created.id);
                  await reload();
                });
              }}>
                <h2>New task</h2>
                <label>Workspace<input value={workspace} onChange={event => { setWorkspace(event.target.value); setKey(crypto.randomUUID()); }} required /></label>
                <label>Task<textarea value={goal} onChange={event => { setGoal(event.target.value); setKey(crypto.randomUUID()); }} required /></label>
                <button className="primary" disabled={busy || !workspace.trim() || !goal.trim()}>Create task</button>
                <label className="checkbox-label"><input type="checkbox" checked={usePersonalMemory} onChange={event => {
                  setUsePersonalMemory(event.target.checked);
                  setKey(crypto.randomUUID());
                }} /> Use personal memory when asking Blazar</label>
                <button type="submit" value="ask" disabled={busy || !workspace.trim() || !goal.trim()}>Ask Blazar</button>
                {answer && <p role="status">{answer}</p>}
                {plan && <section className="approval" aria-label="Proposed workflow">
                  <h3>Proposed workflow</h3>
                  <p>Workspace: {plan.workspace}</p>
                  <ol>{plan.steps.map(step => <li key={step.key}>
                    <strong>{step.key}</strong> · {step.goal}
                    {step.needs.length > 0 && <p>After {step.needs.join(', ')}</p>}
                  </li>)}</ol>
                  <button type="button" disabled={busy} onClick={() => submit(async () => {
                    const created = await api('/workflows', {
                      method: 'POST', key: plan.key, body: { workspace: plan.workspace, steps: plan.steps },
                    });
                    setSelected(created.steps[0].taskId);
                    setPlan(null);
                    setAnswer('');
                    await reload();
                  })}>Create workflow</button>
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
