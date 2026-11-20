import React, { useEffect, useState } from 'react';
import { callRouter } from './router.js';

export function Devices({ token }) {
  const [devices, setDevices] = useState([]);
  const [catalog, setCatalog] = useState(null);
  const [preset, setPreset] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [registration, setRegistration] = useState(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [listRevision, setListRevision] = useState(0);

  useEffect(() => {
    let active = true;
    let timer;
    async function refresh() {
      try {
        const { devices } = await callRouter(token, '/admin/devices');
        if (active) setDevices(devices);
      } catch (failure) {
        if (active) setError(failure.message);
      } finally {
        if (active) timer = setTimeout(refresh, 5000);
      }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [token, listRevision]);

  useEffect(() => {
    const stop = new AbortController();
    callRouter(token, '/admin/workers', { signal: stop.signal })
      .then(next => { if (!stop.signal.aborted) setCatalog(next); })
      .catch(failure => { if (!stop.signal.aborted) setCatalogError(failure.message); });
    return () => stop.abort();
  }, [token]);

  async function update(action) {
    setError('');
    setPending(true);
    try {
      await action();
      setListRevision(revision => revision + 1);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setPending(false);
    }
  }

  return <section className="detail">
    <h2>Execution devices</h2>
    {error && <p role="alert">{error}</p>}
    <form onSubmit={event => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = new FormData(form);
      void update(async () => {
        const device = await callRouter(token, '/admin/devices', {
          method: 'POST', body: { name: values.get('name'), workspace: values.get('workspace') },
        });
        setRegistration(device);
        form.reset();
      });
    }}>
      <label>Device name<input name="name" maxLength={128} required /></label>
      <label>Workspace<input name="workspace" maxLength={128} required /></label>
      <button className="primary" disabled={pending || !!registration}>Register device</button>
    </form>
    {registration && <div>
      <p>Set <code>BLAZAR_DEVICE_TOKEN</code> on {registration.name} using this token.</p>
      <input aria-label="New device token" readOnly value={registration.token} onFocus={event => event.target.select()} />
      <button onClick={() => setRegistration(null)}>Hide token</button>
    </div>}
    <ul>{devices.map(device => <li key={device.id}>
      <strong>{device.name}</strong> · {device.workspace} · {device.revoked ? 'Revoked' : device.interruptedRunId ? 'Needs reconciliation' : device.online ? 'Online' : 'Offline'}
      {device.platform && <> · {device.platform}</>}
      {device.workerLabel ? <> · {device.workerLabel} ({device.workerProtocol.toUpperCase()})</> :
        device.capability && <> · {device.capability}</>}
      {device.lastSeen && <> · Last seen {new Date(device.lastSeen).toLocaleString()}</>}
      {!device.revoked && device.interruptedRunId && <p>Interrupted run <code>{device.interruptedRunId}</code></p>}
      {!device.revoked && <button disabled={pending} onClick={() => void update(async () => {
        await callRouter(token, '/admin/devices/' + device.id, {
          method: 'PATCH', body: { paused: !device.paused },
        });
      })}>{device.paused ? 'Resume assignments' : 'Pause assignments'}</button>}
      {device.paused && !device.revoked && <small>Assignments paused</small>}
      {!device.revoked && <button disabled={pending} onClick={() => {
        if (window.confirm('Revoke this device and suspend its active tasks?')) void update(async () => {
          await callRouter(token, '/admin/devices/' + device.id, { method: 'DELETE' });
          setRegistration(current => current?.id === device.id ? null : current);
        });
      }}>Revoke</button>}
    </li>)}</ul>
    <details>
      <summary>Worker presets</summary>
      {catalogError && <p role="alert">{catalogError}</p>}
      {catalog && <>
        <label>Preset<select value={preset} onChange={event => setPreset(event.target.value)}>
          <option value="">Choose a Worker</option>
          {catalog.presets.map(worker => <option key={worker.id} value={worker.id}>
            {worker.label} ({worker.protocol.toUpperCase()})
          </option>)}
          <option value="custom">Custom ({catalog.extensionProtocols.map(protocol => protocol.toUpperCase()).join(' / ')})</option>
        </select></label>
        {preset && <>
          <p>Set this on the execution device before restarting its service.</p>
          <pre>{'BLAZAR_DEVICE_WORKER=' + preset}</pre>
          {preset === 'custom' && <p>Set <code>BLAZAR_WORKER_MANIFEST</code> to the absolute path to the extension manifest.</p>}
          <p>Check the local configuration with <code>npm run device:probe -- {preset}</code>.</p>
        </>}
      </>}
    </details>
  </section>;
}
