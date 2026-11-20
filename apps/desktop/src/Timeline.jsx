import React, { useEffect, useState } from 'react';
import { callRouter } from './router.js';

const labels = {
  'task.created': 'Task created',
  'task.instruction_added': 'Instruction added',
  'task.cancel_requested': 'Cancellation requested',
  'task.cancelled': 'Task cancelled',
  'run.started': 'Run started',
  'run.progress': 'Progress',
  'run.finished': 'Run finished',
  'run.superseded': 'Run superseded',
  'run.device_revoked': 'Device revoked',
  'run.lease_expired': 'Device lease expired',
  'approval.requested': 'Approval requested',
  'approval.decided': 'Approval decided',
  'artifact.created': 'Artifact saved',
  'workflow.result_outdated': 'An upstream result changed',
};

export function Timeline({ taskId, token, cursor }) {
  const [latest, setLatest] = useState(null);
  const [older, setOlder] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const path = '/tasks/' + taskId + '/timeline';

  useEffect(() => {
    let active = true;
    callRouter(token, path)
      .then(page => { if (active) { setLatest(page); setOlder(null); setError(''); } })
      .catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [token, path, cursor]);

  async function loadOlder() {
    const before = older ? older.before : latest.before;
    setLoading(true);
    try {
      const page = await callRouter(token, path + '?before=' + before);
      setOlder({ before: page.before, events: [...(older?.events ?? []), ...page.events] });
    } catch (failure) { setError(failure.message); }
    finally { setLoading(false); }
  }

  const events = [...new Map([...(latest?.events ?? []), ...(older?.events ?? [])].map(event => [event.seq, event])).values()];
  return (
    <section aria-label="Task activity">
      <h3>Activity</h3>
      {error && <p className="error" role="alert">{error}</p>}
      <ul>{events.map(event => {
        const { data } = event;
        const detail = data?.message ?? data?.text ?? data?.summary ?? data?.decision ?? data?.name ?? data?.status;
        return <li key={event.seq}>
          <strong>{labels[event.type] ?? event.type}</strong>
          {detail && <p>{detail}</p>}
        </li>;
      })}</ul>
      {(older ? older.before : latest?.before) && <button disabled={loading} onClick={loadOlder}>Load older activity</button>}
    </section>
  );
}
