import React, { useState } from 'react';
import { callRouter } from './router.js';

export function AcpRegistry({ token }) {
  const [registry, setRegistry] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const selected = registry?.items.find(item => item.id === selectedId);

  async function load() {
    setLoading(true);
    setError('');
    try {
      setRegistry(await callRouter(token, '/admin/worker-registry'));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setLoading(false);
    }
  }

  return <details>
    <summary>ACP Registry</summary>
    <button type="button" disabled={loading} onClick={() => void load()}>
      {loading ? 'Loading registry…' : registry ? 'Refresh registry' : 'Load registry'}
    </button>
    {error && <p role="alert">{error}</p>}
    {registry?.items.length === 0 && <p>No agents are available in the registry.</p>}
    {registry?.items.length > 0 && <label>Registry Agent<select value={selectedId}
      onChange={event => setSelectedId(event.target.value)}>
      <option value="">Choose an Agent</option>
      {registry.items.map(item => <option key={item.id} value={item.id}>{item.name} {item.version}</option>)}
    </select></label>}
    {selected && <>
      <p>Distributions {selected.distributions.join(', ').toUpperCase()}</p>
      {selected.distributions.includes('npx') && <>
        <p>On the execution device, choose a new installation directory and run:</p>
        <pre>{'npm run device:acp-registry -- install ' + selected.id + ' /absolute/new-directory ' + selected.version}</pre>
      </>}
      {selected.distributions.some(kind => kind === 'uvx' || kind === 'binary') && <p>
        Use <code>npm run device:acp-registry -- import {selected.id}</code> with the distribution and manifest path.
      </p>}
    </>}
  </details>;
}
