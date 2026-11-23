import React, { useEffect, useRef, useState } from 'react';
import { callRouter } from './router.js';

const schedulePath = '/admin/workflow-schedules';

export function Schedules({ token, workspace, workflowSteps, showTask }) {
  const [schedules, setSchedules] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lastSubmission = useRef(null);

  const request = (path, options) => callRouter(token, path, options);
  const reload = async () => setSchedules((await request(schedulePath)).schedules);
  useEffect(() => {
    const stop = new AbortController();
    callRouter(token, schedulePath, { signal: stop.signal })
      .then(data => { if (!stop.signal.aborted) setSchedules(data.schedules); })
      .catch(failure => { if (!stop.signal.aborted) setError(failure.message); });
    return () => stop.abort();
  }, [token]);

  async function perform(operation) {
    setBusy(true);
    setError('');
    try { await operation(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  function createSchedule(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const goals = String(fields.get('steps')).split('\n').map(goal => goal.trim()).filter(Boolean);
    if (!goals.length) { setError('Add at least one Worker step.'); return; }
    const steps = goals.map((goal, index) => ({
      key: 'step-' + (index + 1), goal, needs: index ? ['step-' + index] : [],
      ...(fields.has('review') && { requireReview: true }),
    }));
    const body = {
      workspace, label: fields.get('label'), steps,
      nextAt: new Date(fields.get('start')).getTime(),
      intervalMinutes: fields.get('interval') ? Number(fields.get('interval')) : null,
    };
    const fingerprint = JSON.stringify(body);
    if (lastSubmission.current?.fingerprint !== fingerprint) {
      lastSubmission.current = { fingerprint, key: crypto.randomUUID() };
    }
    const { key } = lastSubmission.current;
    void perform(async () => {
      await request(schedulePath, { method: 'POST', key, body });
      lastSubmission.current = null;
      form.reset();
      await reload();
    });
  }

  return <section className="detail">
    <h2>Scheduled workflows</h2>
    {error && <p className="error" role="alert">{error}</p>}
    <button disabled={busy} onClick={() => perform(reload)}>Refresh schedules</button>
    {schedules.filter(schedule => schedule.workspace === workspace).map(schedule =>
      <article className="workbench-entry" key={schedule.id}>
        <h3>{schedule.label}</h3>
        <p>{!schedule.enabled ? 'Disabled' : schedule.nextAt === null ? 'Dispatched' : 'Next run ' +
          new Date(schedule.nextAt).toLocaleString()}</p>
        <ol>{schedule.steps.map(step => <li key={step.key}>{step.goal}</li>)}</ol>
        {workflowSteps.filter(step => step.workflowId === schedule.lastWorkflowId && !step.predecessorId).map(step =>
          <button key={step.taskId} onClick={() => showTask(step.taskId)}>Open step {step.stepKey}</button>)}
        <button disabled={busy || !schedule.enabled || schedule.nextAt === null} onClick={() => perform(async () => {
          await request(schedulePath + '/' + schedule.id, { method: 'DELETE' });
          await reload();
        })}>Disable future runs</button>
      </article>)}
    <form onSubmit={createSchedule}>
      <fieldset disabled={busy}>
        <legend>New schedule</legend>
        <label>Name<input name="label" required maxLength={160} /></label>
        <label>First run<input name="start" type="datetime-local" required /></label>
        <label>Repeat every (minutes)<input name="interval" type="number" min={1} max={43200} placeholder="Run once" /></label>
        <label>Worker steps, one per line<textarea name="steps" required /></label>
        <label className="checkbox-label"><input name="review" type="checkbox" defaultChecked /> Require review after each step</label>
        <button className="primary">Create schedule</button>
      </fieldset>
    </form>
  </section>;
}
