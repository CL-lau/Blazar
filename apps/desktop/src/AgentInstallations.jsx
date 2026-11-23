import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

const modes = { codex: 'codex-cli', claude: 'claude-cli', pi: 'pi', dsh: 'deepseek', omp: 'omp' };

export function AgentInstallations({ workspace, onAdded }) {
  const [preset, setPreset] = useState('custom');
  const [pending, setPending] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [message, setMessage] = useState('');
  const [agents, setAgents] = useState(null);
  const [error, setError] = useState('');
  const [scan, setScan] = useState(0);

  useEffect(() => {
    let active = true;
    invoke('detect_local_agents').then(result => {
      if (active) setAgents(result);
    }).catch(failure => {
      if (active) setError(failure.message ?? String(failure));
    });
    return () => { active = false; };
  }, [scan]);

  async function addAgent(event) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setPending(true);
    setSetupError('');
    setMessage('');
    try {
      const argumentsText = values.get('args');
      await invoke('add_local_agent', { input: {
        name: values.get('name'), workspace: values.get('workspace'), folder: values.get('folder'),
        executable: values.get('executable'), mode: preset === 'custom' ? 'custom' : modes[preset],
        protocol: values.get('protocol'),
        args: argumentsText ? argumentsText.split(/\r?\n/) : [],
      } });
      setMessage(values.get('name') + ' is online.');
      onAdded();
    } catch (failure) {
      setSetupError(failure.message ?? String(failure));
    } finally {
      setPending(false);
    }
  }

  const selected = agents?.find(agent => agent.id === preset);
  return <section className="detail">
    <h2>Local Agents</h2>
    <button type="button" onClick={() => {
      setAgents(null);
      setError('');
      setScan(value => value + 1);
    }}>Rescan</button>
    {error && <p role="alert">{error}</p>}
    {!agents && !error && <p role="status">Checking this Mac…</p>}
    {agents && <ul>{agents.map(agent => <li key={agent.id}>
      <strong>{agent.name}</strong>{' '}
      {agent.path ? <code>{agent.path}</code> : <span>Executable {agent.command} was not found</span>}
    </li>)}</ul>}
    <details open={pending || message || undefined}>
      <summary>Add Agent on this Mac</summary>
      <form onSubmit={addAgent}>
        <fieldset disabled={pending}>
          <label>Agent type<select value={preset} onChange={event => setPreset(event.target.value)}>
            <option value="custom">Custom Agent</option>
            {agents?.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select></label>
          <div key={preset}>
            <label>Name<input name="name" defaultValue={selected?.name ?? ''} maxLength={128} required /></label>
            <label>Executable path<input name="executable" defaultValue={selected?.path ?? ''} placeholder="/absolute/path" required /></label>
          </div>
          <label>Workspace name<input name="workspace" defaultValue={workspace} maxLength={128} required /></label>
          <label>Git repository path<input name="folder" placeholder="/absolute/path/to/repository" required /></label>
          {preset === 'custom' && <>
            <label>Protocol<select name="protocol"><option value="acp">ACP</option><option value="jsonl">JSONL</option></select></label>
            <label>Arguments, one per line<textarea name="args" maxLength={65000} /></label>
          </>}
          <button className="primary">{pending ? 'Connecting Agent…' : 'Add and start Agent'}</button>
        </fieldset>
      </form>
      {message && <p role="status">{message}</p>}
      {setupError && <p role="alert">{setupError}</p>}
    </details>
  </section>;
}
