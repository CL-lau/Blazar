import React, { useEffect, useState } from 'react';
import { AcpRegistry } from './AcpRegistry.jsx';
import { callRouter } from './router.js';

export function Devices({ token }) {
  const [devices, setDevices] = useState([]);
  const [catalog, setCatalog] = useState(null);
  const [policies, setPolicies] = useState([]);
  const [policyWorkspace, setPolicyWorkspace] = useState('');
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

  useEffect(() => {
    const abort = new AbortController();
    callRouter(token, '/admin/worker-policies', { signal: abort.signal })
      .then(data => { if (!abort.signal.aborted) setPolicies(data.policies); })
      .catch(failure => { if (!abort.signal.aborted) setError(failure.message); });
    return () => abort.abort();
  }, [token]);

  const policy = policies.find(item => item.workspace === policyWorkspace.trim());
  const protocols = [...new Set([
    ...(catalog?.presets.map(worker => worker.protocol) ?? []), ...(catalog?.extensionProtocols ?? []),
  ])].sort();

  async function savePolicy(selected, maxConcurrent, runLimitSeconds, requireReadOnly) {
    const data = await callRouter(token, '/admin/worker-policies', {
      method: 'PUT', body: { workspace: policyWorkspace.trim(), protocols: selected, maxConcurrent, runLimitSeconds, requireReadOnly },
    });
    setPolicies(data.policies);
  }

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
      {device.workerRevision && <p>Adapter v{device.workerAdapterVersion} · Configuration{' '}
        <code title={device.workerRevision}>{device.workerRevision.slice(0, 12)}</code></p>}
      {!device.revoked && device.workerPolicyBlocked === 1 && <p>Workspace policy blocks this Worker from new assignments.</p>}
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
    {protocols.length > 0 && <details>
      <summary>Workspace Worker policies</summary>
      <form onSubmit={event => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const selected = fields.getAll('protocol');
        const limit = fields.get('maxConcurrent');
        const seconds = fields.get('runLimitSeconds');
        void update(() => savePolicy(selected, limit ? Number(limit) : undefined, seconds ? Number(seconds) : undefined, fields.has('requireReadOnly')));
      }}>
        <label>Workspace<input list="worker-policy-workspaces" value={policyWorkspace} maxLength={128}
          onChange={event => setPolicyWorkspace(event.target.value)} required /></label>
        <datalist id="worker-policy-workspaces">{[...new Set([
          ...devices.map(device => device.workspace), ...policies.map(item => item.workspace),
        ])].sort().map(workspace => <option value={workspace} key={workspace} />)}</datalist>
        <fieldset key={JSON.stringify([policyWorkspace.trim(), policy?.protocols, policy?.maxConcurrent, policy?.runLimitSeconds, policy?.requireReadOnly])} disabled={pending}>
          <legend>Allowed protocols for new assignments</legend>
          {protocols.map(protocol => <label key={protocol} className="checkbox-label">
            <input type="checkbox" name="protocol" value={protocol}
              defaultChecked={!policy || policy.protocols.includes(protocol)} /> {protocol.toUpperCase()}
          </label>)}
          <label>Maximum concurrent Worker runs<input type="number" name="maxConcurrent" min="1" max="100" step="1"
            placeholder="No limit" defaultValue={policy?.maxConcurrent ?? ''} /></label>
          <label>Maximum Worker run time in seconds<input type="number" name="runLimitSeconds" min="30" max="600" step="1"
            placeholder="600" defaultValue={policy?.runLimitSeconds ?? ''} /></label>
          <label className="checkbox-label"><input type="checkbox" name="requireReadOnly"
            defaultChecked={policy?.requireReadOnly === true} /> Require read-only Worker execution</label>
          <button disabled={!policyWorkspace.trim()}>Save policy</button>
          {policy && <button type="button" onClick={() => void update(() => savePolicy(null))}>Clear restriction</button>}
        </fieldset>
      </form>
    </details>}
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
          {preset === 'custom' && <>
            <p>Set <code>BLAZAR_WORKER_MANIFEST</code> to the absolute path to the extension manifest.</p>
            <p>To import a pinned ACP preset, run <code>npm run device:acp-registry -- list</code> on the execution device.</p>
          </>}
          <p>Check the local configuration with <code>npm run device:probe -- {preset}</code>.</p>
        </>}
      </>}
    </details>
    <AcpRegistry token={token} />
  </section>;
}
