import React, { useState } from 'react';

export function ApplicationWrite({ connection, request }) {
  const [proposal, setProposal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [clients, setClients] = useState(null);
  const [shareNotice, setShareNotice] = useState('');
  const path = proposal && '/app-write-proposals/' + proposal.id;

  async function run(operation) {
    setError('');
    setBusy(true);
    try { await operation(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  function prepare(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void run(async () => {
      let input;
      try { input = JSON.parse(fields.get('input')); }
      catch { throw new Error('Enter valid JSON for the write input.'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter a JSON object.');
      const { id } = await request('/app-connections/' + connection.id + '/write-proposals', {
        method: 'POST', body: {
          workspace: connection.workspace ?? fields.get('workspace'), capability: fields.get('capability'), input,
        },
      });
      setProposal(await request('/app-write-proposals/' + id));
    });
  }

  function reconcile(event) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    void run(async () => {
      const reconciliation = await request(path + '/reconcile', { method: 'POST', body });
      setProposal({ ...proposal, reconciliation });
    });
  }

  return <details>
    <summary>Application write</summary>
    {error && <p role="alert">{error}</p>}
    {proposal ? <div>
      <p>{proposal.capability} · {proposal.workspace}</p>
      <pre aria-label="Proposed write input">{JSON.stringify(proposal.input, null, 2)}</pre>
      <p role="status">{proposal.status.replaceAll('_', ' ')}</p>
      <p>Proposal ID <code>{proposal.id}</code></p>
      {proposal.status === 'pending' && <button type="button" disabled={busy || proposal.expires <= Date.now()}
        onClick={() => run(async () => {
          const result = await request(path + '/confirm', { method: 'POST' });
          setProposal({ ...proposal, status: result.status });
          setProposal(await request(path));
        })}>Confirm write</button>}
      <button type="button" disabled={busy} onClick={() => run(async () => {
        setProposal(await request(path));
      })}>Refresh status</button>
      {proposal.status === 'pending' && <div>
        <button type="button" disabled={busy} onClick={() => run(async () => {
          const data = await request('/admin/mobile-clients');
          setClients(data.clients);
        })}>Share with paired iPhone</button>
        {clients && <form onSubmit={event => {
          event.preventDefault();
          const client = new FormData(event.currentTarget).get('client') || null;
          void run(async () => {
            await request(path + '/share', { method: 'POST', body: { client } });
            setShareNotice(client ? 'Proposal shared.' : 'Mobile access revoked.');
          });
        }}>
          <label>Paired device<select name="client">
            <option value="">Remove mobile access</option>
            {clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
          </select></label>
          <button disabled={busy}>Save access</button>
        </form>}
        {shareNotice && <p role="status">{shareNotice}</p>}
      </div>}
      {!proposal.reconciliation && proposal.canCheckResult &&
        <button type="button" disabled={busy} onClick={() => run(async () => {
          const { reconciliation } = await request(path + '/check-result', { method: 'POST' });
          if (!reconciliation) throw new Error('The application has not returned a verified result.');
          setProposal({ ...proposal, reconciliation });
        })}>Check external result</button>}
      {proposal.reconciliation ? <p>
        {proposal.reconciliation.resolution.replaceAll('_', ' ')} · {proposal.reconciliation.evidence}
      </p> : ['dispatching', 'outcome_unknown'].includes(proposal.status) && <form onSubmit={reconcile}>
        <label>External result<select name="resolution" required defaultValue="">
          <option value="">Select verified result</option>
          <option value="applied">Applied</option>
          <option value="not_applied">Not applied</option>
        </select></label>
        <label>External evidence<input name="evidence" maxLength={1024} required /></label>
        <button disabled={busy}>Record result</button>
      </form>}
      <button type="button" disabled={busy} onClick={() => { setProposal(null); setError(''); setClients(null); setShareNotice(''); }}>Close proposal</button>
    </div> : <div><form onSubmit={prepare}>
      {!connection.workspace && <label>Workspace<input name="workspace" maxLength={128} required /></label>}
      <label>Capability<select name="capability">
        {connection.writeCapabilities.map(id => <option key={id}>{id}</option>)}
      </select></label>
      <label>Input JSON<textarea name="input" defaultValue="{}" maxLength={12000} required /></label>
      <button disabled={busy}>Review write</button>
    </form>
    <form onSubmit={event => {
      event.preventDefault();
      const id = new FormData(event.currentTarget).get('proposal');
      void run(async () => {
        const restored = await request('/app-write-proposals/' + id);
        if (restored.connection !== connection.id) throw new Error('That proposal belongs to another connection.');
        setProposal(restored);
      });
    }}>
      <label>Proposal ID<input name="proposal" pattern="[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}" required /></label>
      <button disabled={busy}>Open proposal</button>
    </form></div>}
  </details>;
}
