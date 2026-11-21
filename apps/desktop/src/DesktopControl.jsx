import React, { useRef, useState } from 'react';

function targetKey(target) {
  return JSON.stringify([target.deviceId, target.alias]);
}

function inventoryWindows(task) {
  if (task?.status !== 'succeeded') return [];
  try {
    const windows = JSON.parse(task.result);
    return Array.isArray(windows) ? windows.filter(window => window &&
      /^w-[0-9]{1,20}$/.test(window.id) && /^[a-f0-9]{64}$/.test(window.identity)) : [];
  } catch {
    return [];
  }
}

export function DesktopControl({ targets, tasks, workspace, setWorkspace, busy, createTask, showTask }) {
  const [selection, setSelection] = useState('');
  const [inventory, setInventory] = useState(null);
  const [windowId, setWindowId] = useState('');
  const [button, setButton] = useState('');
  const [submitted, setSubmitted] = useState(null);
  const request = useRef(null);
  const available = targets.filter(target => target.workspace === workspace.trim());
  const target = available.find(item => targetKey(item) === selection) ?? available[0];
  const binding = target ? JSON.stringify([target.workspace, target.deviceId, target.alias]) : null;
  const inventoryTask = inventory?.binding === binding ? tasks.find(task => task.id === inventory.id) : undefined;
  const windows = inventoryWindows(inventoryTask);
  const window = windows.find(item => item.id === windowId);
  const controls = target?.controls;
  const targetCommand = target && window
    ? target.alias + ' --window ' + window.id + ' --instance ' + window.identity : null;

  async function dispatch(text, isInventory = false) {
    if (!target) return;
    const body = { workspace: target.workspace, text, desktopDevice: target.deviceId };
    const fingerprint = JSON.stringify(body);
    if (request.current?.fingerprint !== fingerprint) {
      request.current = { fingerprint, key: crypto.randomUUID() };
    }
    const task = await createTask(body, request.current.key);
    if (!task) return;
    request.current = null;
    if (isInventory) {
      setInventory({ id: task.id, binding });
      setWindowId('');
      setButton('');
    }
    setSubmitted({ id: task.id, binding });
  }

  const lastTask = submitted?.binding === binding ? tasks.find(task => task.id === submitted.id) : undefined;
  return <section className="detail">
    <h2>Desktop control</h2>
    <fieldset disabled={busy}>
      <legend>Target</legend>
      <label>Workspace<input value={workspace} maxLength={128} onChange={event => setWorkspace(event.target.value)} /></label>
      {target ? <>
        <label>Device and application<select value={targetKey(target)} onChange={event => {
          setSelection(event.target.value);
          setInventory(null);
          setWindowId('');
          setButton('');
        }}>
          {available.map(item => <option key={targetKey(item)} value={targetKey(item)}>
            {item.deviceName} · {item.alias}
          </option>)}
        </select></label>
        <button type="button" onClick={() => dispatch('/observe ' + target.alias + ' --windows-json', true)}>List windows</button>
      </> : <p>No desktop targets are available in this workspace.</p>}
    </fieldset>
    {inventory?.binding === binding && <fieldset disabled={busy}>
      <legend>Window operations</legend>
      {inventoryTask?.status !== 'succeeded' ? <p role="status">Window inventory {inventoryTask?.status?.replaceAll('_', ' ') ?? 'pending'}.</p>
        : windows.length === 0 ? <p role="status">No identifiable windows found.</p> : <>
          <label>Window<select value={window?.id ?? ''} onChange={event => setWindowId(event.target.value)}>
            <option value="">Choose a window</option>
            {windows.map(item => <option key={item.id} value={item.id}>{item.title || item.id}</option>)}
          </select></label>
          <button type="button" disabled={!targetCommand || !window?.accessible || target.accessibility === 'denied'}
            onClick={() => dispatch('/observe ' + targetCommand)}>Inspect window</button>
          {controls?.visual && <button type="button" disabled={!targetCommand || target.screenRecording === 'denied'}
            onClick={() => dispatch('/observe ' + targetCommand + ' --visual')}>Capture screenshot</button>}
          {controls?.visual && <button type="button" disabled={!targetCommand || !window?.accessible ||
            target.accessibility === 'denied' || target.screenRecording === 'denied'}
            onClick={() => dispatch('/observe ' + targetCommand + ' --hybrid')}>Inspect and capture</button>}
          {controls?.visual && target.screenRecording === 'denied' && <p>Grant Screen Recording permission on the device to capture screenshots.</p>}
          {controls?.buttons?.length > 0 && <>
            <label>Button<select value={button} onChange={event => setButton(event.target.value)}>
              <option value="">Choose a button</option>
              {controls.buttons.map(label => <option key={label}>{label}</option>)}
            </select></label>
            <button type="button" disabled={!targetCommand || !window?.accessible ||
              target.accessibility === 'denied' || !controls.buttons.includes(button)}
              onClick={() => dispatch('/click ' + targetCommand + ' ' + button)}>Request click approval</button>
          </>}
        </>}
    </fieldset>}
    {submitted?.binding === binding && <p role="status">
      {lastTask ? lastTask.status.replaceAll('_', ' ') : 'Submitted'}{' '}
      <button type="button" onClick={() => showTask(submitted.id)}>View task</button>
    </p>}
  </section>;
}
