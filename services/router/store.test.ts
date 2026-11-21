import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from './store.ts';

test('deduplicates creation and fences results after a newer instruction', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const task = db.create('owner', 'desktop', 'first', 'project', 'Review');
  assert.equal(db.create('owner', 'desktop', 'first', 'project', 'Review').id, task.id);
  assert.throws(() => db.create('owner', 'desktop', 'first', 'project', 'Different'));
  assert.equal(db.get('another', task.id), undefined);
  const first = db.claim('owner', 'project', 'device', 0, 10)!;
  assert.equal(db.command('owner', task.id, 1, { action: 'append', text: 'Include tests' })?.version, 2);
  assert.equal(db.finish(first.run.id, 'device', 1, { status: 'succeeded', result: 'Stale' }), false);
  const next = db.claim('owner', 'project', 'device', 2, 10)!;
  assert.deepEqual(next.instructions, ['Include tests']);
  assert.equal(db.finish(next.run.id, 'device', 3, { status: 'succeeded', result: 'Updated' }), true);
  assert.equal(db.get('owner', task.id)?.result, 'Updated');
  assert.equal(db.events('another', 0).length, 0);
});

test('cancellation prevents lease renewal and late completion', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const task = db.create('owner', 'desktop', 'first', 'project', 'Review');
  const { run } = db.claim('owner', 'project', 'device', 0, 10)!;
  assert.equal(db.command('owner', task.id, 1, { action: 'cancel' })?.status, 'cancelling');
  assert.equal(db.renew(run.id, 'device', 5, 10), undefined);
  assert.equal(db.expire(10), 1);
  assert.equal(db.finish(run.id, 'device', 11, { status: 'succeeded', result: 'Late' }), false);
  assert.equal(db.get('owner', task.id)?.status, 'cancelled');
});

test('an appended instruction stops the superseded run and queues the latest version after cleanup', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const task = db.create('owner', 'desktop', 'first', 'project', 'Review');
  const { run } = db.claim('owner', 'project', 'device', 0, 100)!;
  assert.equal(db.command('owner', task.id, 1, { action: 'append', text: 'Include tests' })?.version, 2);
  assert.deepEqual({ ...db.stopTarget('owner', task.id) }, { runId: run.id, device: 'device' });
  assert.deepEqual(db.deviceStopTargets('device').map(item => item.id), [run.id]);
  assert.equal(db.renew(run.id, 'device', 1, 100), undefined);
  assert.equal(db.claim('owner', 'project', 'another', 2, 100), undefined);
  assert.equal(db.acknowledgeStop(run.id, 'another', 3), false);
  assert.equal(db.acknowledgeStop(run.id, 'device', 3), true);
  assert.equal(db.finish(run.id, 'device', 4, { status: 'succeeded', result: 'Old result' }), false);
  const next = db.claim('owner', 'project', 'device', 5, 100)!;
  assert.equal(next.run.version, 2);
  assert.deepEqual(next.instructions, ['Include tests']);
});

test('reconciles an expired run after restart and preserves the event cursor', t => {
  const directory = mkdtempSync(join(tmpdir(), 'blazar-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'router.sqlite');
  const initial = new TaskStore(path);
  const task = initial.create('owner', 'desktop', 'first', 'project', 'Review');
  const { run } = initial.claim('owner', 'project', 'device', 0, 10)!;
  const cursor = initial.events('owner', 0).at(-1)!.seq;
  initial.close();

  const reopened = new TaskStore(path);
  t.after(() => reopened.close());
  assert.equal(reopened.expire(10), 1);
  assert.equal(reopened.get('owner', task.id)?.status, 'waiting_user');
  assert.equal(reopened.finish(run.id, 'device', 11, { status: 'succeeded', result: 'Late' }), false);
  assert.deepEqual(reopened.events('owner', cursor).map(event => event.type), ['run.lease_expired']);
});

test('approvals bind decisions to the current run, owner, and task version', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const now = Date.now();
  const task = db.create('owner', 'desktop', 'approval', 'project', 'Prepare a draft');
  const { run } = db.claim('owner', 'project', 'device', now, 45_000)!;
  const pending = db.requestApproval(run.id, 'device', 'Release the prepared draft for review', now)!;
  const approvalId = String(pending.id);
  assert.equal(db.progress(run.id, 'device', now + 1, 1, 'Worker completed a tool call'), true);
  assert.equal(db.get('owner', task.id)?.status, 'waiting_user');
  assert.equal(db.requestApproval(run.id, 'device', 'A different action', now), undefined);
  assert.equal(db.snapshot('owner').approvals.length, 1);
  assert.equal(db.snapshot('other').approvals.length, 0);
  assert.equal(db.finish(run.id, 'device', now, { status: 'succeeded', result: 'Premature' }), false);
  assert.equal(db.renew(run.id, 'device', now + 1, 45_000), now + 45_001);
  assert.equal(db.command('other', task.id, 1, { action: 'approve', approvalId }), undefined);

  assert.equal(db.command('owner', task.id, 1, { action: 'append', text: 'Revise the draft' })?.version, 2);
  assert.equal(db.command('owner', task.id, 2, { action: 'approve', approvalId }), undefined);
  assert.equal(db.approvalForRun(run.id, 'device', approvalId, now + 2), undefined);
  assert.equal(db.finish(run.id, 'device', now + 2, { status: 'failed', result: 'Superseded' }), false);

  const next = db.claim('owner', 'project', 'device', now + 3, 45_000)!;
  const nextApproval = db.requestApproval(next.run.id, 'device', 'Review updated draft', now + 3)!;
  const decision = { action: 'approve' as const, approvalId: String(nextApproval.id) };
  assert.equal(db.command('owner', task.id, 2, decision, 'approval-command')?.status, 'running');
  assert.equal(db.command('owner', task.id, 2, decision, 'approval-command')?.status, 'running');
  assert.equal(db.command('owner', task.id, 2, { ...decision, action: 'deny' }), undefined);
  assert.equal(db.approvalForRun(next.run.id, 'other-device', decision.approvalId, now + 4), undefined);
  assert.equal(db.approvalForRun(next.run.id, 'device', decision.approvalId, now + 4)?.decision, 'approved');
  assert.equal(db.consumeApproval(next.run.id, 'other-device', decision.approvalId, now + 4), false);
  assert.equal(db.consumeApproval(next.run.id, 'device', decision.approvalId, now + 4), true);
  assert.equal(db.consumeApproval(next.run.id, 'device', decision.approvalId, now + 5), false);
});

test('progress requires a current run and consecutive device sequences', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const task = db.create('owner', 'desktop', 'progress', 'project', 'Read notes');
  const { run } = db.claim('owner', 'project', 'device', 0, 100)!;
  assert.equal(db.progress(run.id, 'device', 1, 2, 'Too early'), false);
  assert.equal(db.progress(run.id, 'other', 1, 1, 'Wrong device'), false);
  assert.equal(db.progress(run.id, 'device', 1, 1, 'Reading'), true);
  assert.equal(db.progress(run.id, 'device', 2, 1, 'Reading'), true);
  assert.equal(db.progress(run.id, 'device', 2, 1, 'Different'), false);
  assert.equal(db.progress(run.id, 'device', 3, 2, 'Formatting'), true);
  assert.deepEqual(db.snapshot('owner').progress.map(item => item.message), ['Formatting']);
  assert.equal(db.snapshot('other').progress.length, 0);
  db.command('owner', task.id, 1, { action: 'append', text: 'Use bullet points' });
  assert.equal(db.progress(run.id, 'device', 4, 3, 'Stale'), false);
  assert.equal(db.snapshot('owner').progress.length, 0);
  assert.equal(db.events('owner', 0).filter(event => event.type === 'run.progress').length, 2);
});

test('channel delivery metrics count outcomes without exposing conversation identities', t => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const now = Date.now();
  const channel = JSON.stringify(['qq', 'hidden-bot']);
  const add = (owner: string, id: string, expires: number) => {
    store.receiveChannelMessage(owner, channel, 'workspace', {
      id, chat: 'hidden-chat', thread: id, root: true, text: 'Review notes', replyExpires: expires,
    });
    const { run } = store.claim(owner, 'workspace', 'device', now, 45_000)!;
    assert.equal(store.finish(run.id, 'device', now, { status: 'succeeded', result: 'Private' }), true);
  };
  for (const id of ['sent', 'failed', 'unknown', 'pending']) add('owner', id, now + 60_000);
  const finish = (outcome: boolean) => store.finishChannelNotice(
    store.leasePassiveNotice(channel, Date.now(), ['hidden-chat'])!.id, outcome);
  finish(true);
  finish(false);
  assert.equal(store.leasePassiveNotice(channel, Date.now(), ['hidden-chat'])?.messageId, 'unknown');
  add('owner', 'expired', now - 1);
  add('other', 'elsewhere', now + 60_000);
  const metrics = store.metrics('owner', now);
  assert.deepEqual(metrics.channelDelivery.map(row => ({ ...row })),
    [{ channel: 'qq', sent: 1, failed: 1, unknown: 1, expired: 1, pending: 1 }]);
  assert.deepEqual(store.metrics('other', now).channelDelivery.map(row => ({ ...row })),
    [{ channel: 'qq', sent: 0, failed: 0, unknown: 0, expired: 0, pending: 1 }]);
  assert.doesNotMatch(JSON.stringify(metrics), /hidden-bot|hidden-chat|Private/);
});

test('queue latency counts each actual dispatch and survives a Router restart', t => {
  const root = mkdtempSync(join(tmpdir(), 'blazar-queue-metrics-'));
  const path = join(root, 'router.sqlite');
  let store = new TaskStore(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const task = store.create('owner', 'fixture', 'queued', 'project', 'Read notes');
  const now = Date.now();
  store.updateDeviceReadiness(now);
  assert.equal(store.get('owner', task.id)?.status, 'waiting_device');
  const key = 'request';
  const assignment = store.claim('owner', 'project', 'device', now + 2_000, 45_000, '', '', key)!;
  assert.equal(store.claim('owner', 'project', 'device', now + 2_001, 45_000, '', '', key)?.run.id, assignment.run.id);
  const start = store.timeline('owner', task.id)?.events.find(event => event.type === 'run.started');
  const wait = Number(start?.data.queueWaitMs);
  assert.ok(wait >= 2_000);
  const latency = store.metrics('owner', now).queueLatencyMs;
  assert.deepEqual(latency, { count: 1, mean: wait, p95UpperBound: 5_000 });
  assert.equal(store.metrics('other', now).queueLatencyMs.count, 0);
  store.close();
  store = new TaskStore(path);
  assert.deepEqual(store.metrics('owner', now).queueLatencyMs, latency);
});

test('the watchdog reports silent live runs once and clears the warning after new progress', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const task = db.create('owner', 'desktop', 'silence', 'project', 'Read notes');
  const now = Date.now();
  const { run } = db.claim('owner', 'project', 'device', now, 45_000)!;
  for (const elapsed of [30_000, 60_000, 90_000, 119_999]) {
    assert.ok(db.renew(run.id, 'device', now + elapsed, 45_000));
  }
  assert.equal(db.watchSilentRuns(now + 119_999), 0);
  assert.equal(db.watchSilentRuns(now + 120_000), 1);
  assert.equal(db.watchSilentRuns(now + 120_001), 0);
  assert.match(String(db.snapshot('owner').progress[0].message), /No recent Worker output/);
  assert.equal(db.snapshot('other').progress.length, 0);
  assert.equal(db.get('owner', task.id)?.status, 'running');
  assert.equal(db.timeline('owner', task.id)?.events.filter(event => event.type === 'run.stalled').length, 1);
  assert.equal(db.progress(run.id, 'device', now + 120_002, 1, 'Reading again'), true);
  assert.equal(db.snapshot('owner').progress[0].message, 'Reading again');
  assert.equal(db.watchSilentRuns(now + 120_003), 0);
  assert.equal(db.watchSilentRuns(now + 250_000), 0);
});

test('timeline pages stay scoped to the task and owner', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const task = db.create('owner', 'desktop', 'timeline', 'project', 'Review notes');
  for (let i = 1; i <= 52; i++) {
    assert.ok(db.command('owner', task.id, i, { action: 'append', text: 'Revision ' + i }));
  }
  db.create('owner', 'desktop', 'other-task', 'project', 'Another task');
  const latest = db.timeline('owner', task.id)!;
  assert.equal(latest.events.length, 50);
  assert.equal(latest.events[0].data.text, 'Revision 52');
  assert.equal(latest.before, latest.events.at(-1)?.seq);
  const older = db.timeline('owner', task.id, latest.before!)!;
  assert.equal(older.events.length, 3);
  assert.equal(older.events.at(-1)?.type, 'task.created');
  assert.equal(older.before, null);
  assert.equal(db.timeline('other-owner', task.id), undefined);
});

test('workflow creation is atomic and dependent steps receive completed results', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  assert.throws(() => db.createWorkflow('owner', 'cycle', 'project', [
    { key: 'a', goal: 'A', needs: ['b'] }, { key: 'b', goal: 'B', needs: ['a'] },
  ]));
  assert.equal(db.snapshot('owner').tasks.length, 0);
  const steps = [
    { key: 'review', goal: 'Review notes', needs: ['draft', 'reference'] },
    { key: 'draft', goal: 'Write notes', needs: [] },
    { key: 'reference', goal: 'Find references', needs: [] },
  ];
  const workflow = db.createWorkflow('owner', 'plan', 'project', steps);
  assert.equal(db.createWorkflow('owner', 'plan', 'project', steps).id, workflow.id);
  assert.equal(db.snapshot('other').workflowSteps.length, 0);

  const draft = db.claim('owner', 'project', 'first', 0, 100)!;
  const reference = db.claim('owner', 'project', 'second', 0, 100)!;
  assert.equal(draft.task.goal, 'Write notes');
  assert.equal(reference.task.goal, 'Find references');
  assert.equal(db.claim('owner', 'project', 'third', 0, 100), undefined);
  db.finish(draft.run.id, 'first', 1, { status: 'succeeded', result: 'Draft text' });
  assert.equal(db.claim('owner', 'project', 'third', 2, 100), undefined);
  db.finish(reference.run.id, 'second', 2, { status: 'succeeded', result: 'Source material' });
  const review = db.claim('owner', 'project', 'third', 3, 100)!;
  assert.equal(review.task.goal, 'Review notes');
  assert.deepEqual(review.predecessors.map(item => item.result), ['Draft text', 'Source material']);
});

test('device presence expires and cannot reactivate a revoked device', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const { id } = db.registerDevice('owner', 'Laptop', 'project');
  db.recordDeviceActivity(id, 1000, 'agent.acp', 'darwin');
  db.recordDeviceActivity(id, 11000);
  assert.equal(db.devices('owner', 56000)[0].online, 1);
  assert.equal(db.devices('owner', 56001)[0].online, 0);
  assert.equal(db.devices('owner', 56001)[0].capability, 'agent.acp');
  assert.deepEqual(db.devices('someone-else', 11000), []);
  assert.equal(db.revokeDevice('owner', id), true);
  assert.equal(db.devices('owner', 11000)[0].online, 0);
});

test('watchdog records a pending approval timeout and fences the expired run', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const now = Date.now();
  const task = db.create('owner', 'desktop', 'approval-timeout', 'project', 'Prepare a draft');
  const { run } = db.claim('owner', 'project', 'device', now, 400_000)!;
  const approval = db.requestApproval(run.id, 'device', 'Send the draft', now)!;
  const expiry = Number(approval.expires);
  const cursor = db.snapshot('owner').cursor;
  assert.equal(db.expire(expiry - 1), 0);
  assert.equal(db.expire(expiry), 1);
  assert.equal(db.expire(expiry + 1), 0);
  assert.equal(db.get('owner', task.id)?.status, 'failed');
  assert.match(db.get('owner', task.id)?.result ?? '', /approval expired/i);
  assert.equal(db.renew(run.id, 'device', expiry + 1, 45_000), undefined);
  assert.equal(db.finish(run.id, 'device', expiry + 1, { status: 'succeeded', result: 'Late' }), false);
  assert.equal(db.consumeApproval(run.id, 'device', String(approval.id), expiry + 1), false);
  const events = db.events('owner', cursor);
  assert.deepEqual(events.map(event => event.type), ['approval.expired']);
  assert.equal(JSON.parse(events[0].data).approvalId, approval.id);
});

test('a delayed watchdog preserves whichever of the approval or execution lease expired first', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const now = Date.now();
  const approvalFirst = db.create('owner', 'desktop', 'approval-first', 'approval-workspace', 'Prepare notes');
  const leaseFirst = db.create('owner', 'desktop', 'lease-first', 'lease-workspace', 'Prepare a draft');
  const first = db.claim('owner', 'approval-workspace', 'device-one', now, 400_000)!.run;
  const second = db.claim('owner', 'lease-workspace', 'device-two', now, 45_000)!.run;
  assert.ok(db.requestApproval(first.id, first.device, 'Approve notes', now));
  assert.ok(db.requestApproval(second.id, second.device, 'Approve draft', now));
  const cursor = db.eventCursor();

  assert.equal(db.expire(now + 450_000), 2);
  assert.equal(db.expire(now + 450_000), 0);
  assert.equal(db.get('owner', approvalFirst.id)?.status, 'failed');
  assert.equal(db.get('owner', leaseFirst.id)?.status, 'waiting_user');
  assert.deepEqual(db.events('owner', cursor).map(({ taskId, type }) => ({ taskId, type })), [
    { taskId: approvalFirst.id, type: 'approval.expired' },
    { taskId: leaseFirst.id, type: 'run.lease_expired' },
  ]);
});

test('failed workflow predecessors keep dependent steps waiting until a retry succeeds', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const workflow = db.createWorkflow('owner', 'dependency-recovery', 'project', [
    { key: 'draft', goal: 'Draft', needs: [] },
    { key: 'review', goal: 'Review', needs: ['draft'] },
    { key: 'publish', goal: 'Prepare publication', needs: ['review'] },
  ]);
  const ids = Object.fromEntries(workflow.steps.map(step => [step.key, String(step.taskId)]));
  const draft = db.claim('owner', 'project', 'device', 0, 100)!;
  assert.equal(db.finish(draft.run.id, 'device', 1, { status: 'failed', result: 'Draft failed' }), true);
  assert.equal(db.get('owner', ids.review)?.status, 'waiting_dependency');
  assert.equal(db.get('owner', ids.publish)?.status, 'waiting_dependency');
  assert.equal(db.claim('owner', 'project', 'device', 2, 100), undefined);
  assert.equal(db.command('owner', ids.draft, 1, { action: 'append', text: 'Retry with the updated source' })?.status, 'queued');
  const retry = db.claim('owner', 'project', 'device', 3, 100)!;
  assert.equal(db.finish(retry.run.id, 'device', 4, { status: 'succeeded', result: 'New draft' }), true);
  assert.equal(db.get('owner', ids.review)?.status, 'queued');
  assert.equal(db.get('owner', ids.publish)?.status, 'waiting_dependency');
  assert.equal(db.command('owner', ids.publish, 1, { action: 'cancel' })?.status, 'cancelled');
  const review = db.claim('owner', 'project', 'device', 5, 100)!;
  assert.deepEqual(review.predecessors.map(item => [item.version, item.result]), [[2, 'New draft']]);
  assert.equal(db.finish(review.run.id, 'device', 6, { status: 'succeeded', result: 'Reviewed' }), true);
  assert.equal(db.get('owner', ids.publish)?.status, 'cancelled');
});

test('running workflow steps cannot commit after a predecessor is replaced', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const now = Date.now();
  db.createWorkflow('owner', 'version-fence', 'project', [
    { key: 'draft', goal: 'Draft', needs: [] },
    { key: 'review', goal: 'Review', needs: ['draft'] },
  ]);
  const draft = db.claim('owner', 'project', 'author', now, 100)!;
  assert.equal(db.finish(draft.run.id, 'author', now + 1, {
    status: 'succeeded', result: 'First draft', artifact: { name: 'draft.md', text: 'Original artifact' },
  }), true);
  const review = db.claim('owner', 'project', 'reviewer', now + 2, 100)!;
  const approval = db.requestApproval(review.run.id, 'reviewer', 'Approve the review', now + 3)!;
  assert.equal(db.command('owner', draft.task.id, 1, { action: 'append', text: 'Replace the draft' })?.version, 2);
  assert.equal(db.snapshot('owner').approvals.length, 0);
  assert.equal(db.command('owner', review.task.id, 1, { action: 'approve', approvalId: String(approval.id) }), undefined);
  assert.equal(db.renew(review.run.id, 'reviewer', now + 4, 100), undefined);
  const revised = db.claim('owner', 'project', 'author', now + 5, 100)!;
  assert.equal(db.finish(revised.run.id, 'author', now + 6, {
    status: 'succeeded', result: 'Revised draft', artifact: { name: 'draft.md', text: 'X'.repeat(2100) },
  }), true);
  assert.equal(db.finish(review.run.id, 'reviewer', now + 7, {
    status: 'succeeded', result: 'Stale review', artifact: { name: 'review.txt', text: 'Old facts' },
  }), false);
  assert.equal(db.snapshot('owner').artifacts.filter(artifact => artifact.taskId === review.task.id).length, 0);
  assert.equal(db.get('owner', review.task.id)?.status, 'waiting_user');
  assert.equal(db.claim('owner', 'project', 'reviewer', now + 8, 100), undefined);
  db.command('owner', review.task.id, 1, { action: 'append', text: 'Review the revised draft' });
  const retry = db.claim('owner', 'project', 'reviewer', now + 9, 100)!;
  assert.deepEqual(retry.predecessors.map(input => input.result), ['Revised draft']);
  const artifact = retry.predecessors[0].artifact!;
  assert.equal(retry.predecessors[0].version, 2);
  assert.equal(artifact.name, 'draft.md');
  assert.equal(artifact.excerpt, 'X'.repeat(2000));
  assert.equal(artifact.truncated, true);
  assert.equal(artifact.id, db.snapshot('owner').artifacts[0].id);
  assert.equal(db.runInputArtifact(retry.run.id, 'author', artifact.id, now + 10), undefined);
  assert.equal(db.runInputArtifact(retry.run.id, 'reviewer', review.predecessors[0].artifact!.id, now + 10), undefined);
  assert.equal(Buffer.from(db.runInputArtifact(retry.run.id, 'reviewer', artifact.id, now + 10)!.content).toString(),
    'X'.repeat(2100));
  db.command('owner', draft.task.id, 2, { action: 'append', text: 'Revise it again' });
  assert.equal(db.runInputArtifact(retry.run.id, 'reviewer', artifact.id, now + 11), undefined);
});

test('waiting-device tasks reflect capability, workspace, and recent healthy presence', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const task = db.create('owner', 'desktop', 'preview', 'project', '/preview notes.md');
  const incompatible = db.registerDevice('owner', 'Agent device', 'project');
  const elsewhere = db.registerDevice('owner', 'Preview device', 'another-project');
  const matching = db.registerDevice('owner', 'Preview device', 'project');
  db.recordDeviceActivity(incompatible.id, 100, 'agent.acp');
  db.recordDeviceActivity(elsewhere.id, 100, 'document.preview');
  assert.equal(db.updateDeviceReadiness(100), 1);
  assert.equal(db.get('owner', task.id)?.status, 'waiting_device');
  db.recordDeviceActivity(matching.id, 101, 'document.preview');
  assert.equal(db.updateDeviceReadiness(101), 1);
  assert.equal(db.get('owner', task.id)?.status, 'queued');
  assert.equal(db.updateDeviceReadiness(45102), 1);
  assert.equal(db.updateDeviceReadiness(45103), 0);
  db.recordDeviceActivity(matching.id, 45104, 'document.preview');
  const claimed = db.claim('owner', 'project', matching.id, 45104, 100, '/preview ');
  assert.equal(claimed?.task.id, task.id);
});

test('paused devices finish their current run and claim new work only after resuming', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const device = db.registerDevice('owner', 'Device', 'project');
  db.recordDeviceActivity(device.id, 1, 'document.preview');
  const first = db.create('owner', 'desktop', 'first-preview', 'project', '/preview first.md');
  const second = db.create('owner', 'desktop', 'second-preview', 'project', '/preview second.md');
  const live = db.claim('owner', 'project', device.id, 1, 100, '/preview ')!;
  assert.equal(live.task.id, first.id);
  assert.equal(db.setDevicePaused('other', device.id, true), false);
  assert.equal(db.setDevicePaused('owner', device.id, true), true);
  assert.equal(db.devices('owner', 1)[0].paused, 1);
  db.updateDeviceReadiness(2);
  assert.equal(db.get('owner', second.id)?.status, 'waiting_device');
  assert.equal(db.claim('owner', 'project', device.id, 2, 100, '/preview '), undefined);
  assert.equal(db.renew(live.run.id, device.id, 2, 100), 102);
  assert.equal(db.finish(live.run.id, device.id, 3, { status: 'succeeded', result: 'Finished' }), true);
  assert.equal(db.setDevicePaused('owner', device.id, false), true);
  assert.equal(db.claim('owner', 'project', device.id, 4, 100, '/preview ')?.task.id, second.id);
});

test('running tasks require acknowledgement before resume and reject old results', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const task = db.create('owner', 'desktop', 'pausable', 'project', 'Read notes');
  const first = db.claim('owner', 'project', 'device', 10, 100)!;
  assert.equal(db.command('owner', task.id, 1, { action: 'pause' })?.status, 'pausing');
  assert.equal(db.command('owner', task.id, 2, { action: 'resume' }), undefined);
  assert.equal(db.renew(first.run.id, 'device', 11, 100), undefined);
  assert.equal(db.acknowledgeStop(first.run.id, 'another-device', 11), false);
  assert.equal(db.acknowledgeStop(first.run.id, 'device', 11), true);
  assert.equal(db.get('owner', task.id)?.status, 'paused');
  assert.equal(db.claim('owner', 'project', 'device', 12, 100), undefined);
  assert.equal(db.finish(first.run.id, 'device', 12, { status: 'succeeded', result: 'Old' }), false);
  assert.equal(db.command('owner', task.id, 2, { action: 'resume' })?.status, 'queued');
  const resumed = db.claim('owner', 'project', 'device', 13, 100)!;
  assert.equal(resumed.task.version, 3);
  assert.notEqual(resumed.run.id, first.run.id);
  assert.equal(db.command('owner', task.id, 3, { action: 'pause' })?.status, 'pausing');
  assert.equal(db.expire(113), 1);
  assert.equal(db.get('owner', task.id)?.status, 'waiting_user');
});

test('single-use link codes attach a second channel to the same task and workspace', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  db.receiveChannelMessage('owner', 'weixin', 'project', {
    id: 'root', chat: 'original', thread: 'root', root: true, text: 'Review the draft',
  });
  const task = db.snapshot('owner').tasks[0];
  assert.equal(db.createTaskLink('other', task.id, Date.now()), undefined);
  const code = db.createTaskLink('owner', task.id, Date.now())!.code;
  const message = (id: string, chat: string) => ({ id, chat, thread: id, root: true, text: '/link ' + code });
  db.receiveChannelMessage('owner', 'feishu', 'wrong', message('wrong', 'wrong-chat'));
  db.receiveChannelMessage('owner', 'feishu', 'project', message('linked', 'authorized-chat'));
  db.receiveChannelMessage('owner', 'feishu', 'project', message('replay', 'third-chat'));
  const follow = (chat: string, thread: string, id: string) => ({
    id, chat, thread, root: false, text: 'Add the conclusion',
  });
  db.receiveChannelMessage('owner', 'feishu', 'project', follow('third-chat', 'replay', 'bad-follow'));
  db.receiveChannelMessage('owner', 'feishu', 'project', follow('authorized-chat', 'linked', 'follow'));
  assert.equal(db.snapshot('owner').tasks.length, 1);
  assert.equal(db.get('owner', task.id)?.version, 2);
  const events = db.timeline('owner', task.id)!.events;
  assert.deepEqual(events.map(entry => entry.type), ['task.instruction_added', 'task.channel_linked', 'task.created']);
  assert(!JSON.stringify(events).includes(code));
  const assignment = db.claim('owner', 'project', 'device', Date.now(), 45_000)!;
  assert.equal(db.finish(assignment.run.id, 'device', Date.now(), { status: 'succeeded', result: 'Reviewed' }), true);
  const link = db.taskChannels('owner', task.id).find(item => item.channel === 'feishu')!;
  assert.equal(link.delivery, 'pending');
  assert.deepEqual(db.taskChannels('other', task.id), []);
  assert.equal(db.unlinkTaskChannel('other', task.id, link.id), false);
  assert.equal(db.unlinkTaskChannel('owner', task.id, link.id), true);
  assert.equal(db.leaseChannelNotice('feishu', Date.now()), undefined);
  const notice = db.leaseChannelNotice('weixin', Date.now(), undefined, true)!;
  assert.equal(notice.messageId, 'root');
  assert.equal(db.taskChannels('owner', task.id)[0].delivery, 'unknown');
  db.finishChannelNotice(notice.id, true);
  assert.equal(db.taskChannels('owner', task.id)[0].delivery, 'sent');
  db.receiveChannelMessage('owner', 'feishu', 'project', follow('authorized-chat', 'linked', 'after-unlink'));
  assert.equal(db.get('owner', task.id)?.version, 2);
  assert.equal(db.taskChannels('owner', task.id).length, 1);
});

test('a run cannot extend its lease past the Router time limit', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const task = db.create('owner', 'desktop', 'deadline', 'project', 'Review notes');
  const { run } = db.claim('owner', 'project', 'device', 0, 600_000)!;
  assert.equal(db.renew(run.id, 'device', 599_999, 45_000), 600_000);
  assert.equal(db.renew(run.id, 'device', 600_000, 45_000), undefined);
  assert.equal(db.finish(run.id, 'device', 600_000, { status: 'succeeded', result: 'Late result' }), false);
  assert.equal(db.expire(600_000), 1);
  assert.equal(db.get('owner', task.id)?.status, 'waiting_user');
  assert.equal(db.timeline('owner', task.id)?.events[0].type, 'run.deadline_exceeded');
});

test('run recovery metrics survive restart and remain scoped to the task owner', t => {
  const dir = mkdtempSync(join(tmpdir(), 'blazar-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'router.sqlite');
  const db = new TaskStore(file);
  try {
    db.create('owner', 'desktop', 'lease-expiry', 'project', 'Review notes');
    db.create('other', 'desktop', 'run-timeout', 'project', 'Read the draft');
    assert.ok(db.claim('owner', 'project', 'device', 0, 45_000));
    assert.ok(db.claim('other', 'project', 'other-device', 0, 600_000));
    assert.equal(db.expire(45_000), 1);
    assert.equal(db.expire(600_000), 1);
    assert.equal(db.expire(600_000), 0);
  } finally {
    db.close();
  }

  const reopened = new TaskStore(file);
  try {
    assert.deepEqual(reopened.metrics('owner', 600_000).runRecovery, {
      leaseExpired: 1, deadlineExceeded: 0, deviceInterrupted: 0, deviceRevoked: 0,
    });
    assert.deepEqual(reopened.metrics('other', 600_000).runRecovery, {
      leaseExpired: 0, deadlineExceeded: 1, deviceInterrupted: 0, deviceRevoked: 0,
    });
  } finally {
    reopened.close();
  }
});

test('workspace Worker time limits apply at claim and survive policy changes', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  db.setWorkspaceWorkerPolicy('owner', 'project', ['jsonl'], undefined, 30);
  const claim = (now: number) => db.claim('owner', 'project', 'device', now, 45_000, '', '', undefined,
    { label: 'Fixture', protocol: 'jsonl' });
  const task = db.create('owner', 'desktop', 'deadline', 'project', 'Review notes');
  const { run } = claim(0)!;
  assert.equal(run.expires, 30_000);

  db.setWorkspaceWorkerPolicy('owner', 'project', ['jsonl'], undefined, 120);
  assert.equal(db.renew(run.id, 'device', 10_000, 45_000), 30_000);
  assert.equal(db.expire(30_000), 1);
  assert.equal(db.timeline('owner', task.id)?.events[0].type, 'run.deadline_exceeded');

  db.create('owner', 'desktop', 'next', 'project', 'Review more notes');
  const next = claim(30_000)!.run;
  assert.equal(next.expires, 75_000);
  assert.equal(db.renew(next.id, 'device', 70_000, 90_000), 150_000);
});

test('only completed failures and reconciled runs can be retried as a new version', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const now = Date.now();
  const task = db.create('owner', 'desktop', 'retry', 'project', 'Review notes');
  const first = db.claim('owner', 'project', 'device', now, 100)!;
  db.requestApproval(first.run.id, 'device', 'Review this action', now);
  assert.equal(db.command('owner', task.id, 1, { action: 'retry' }), undefined);
  db.expire(now + 100);
  const retry = db.command('owner', task.id, 1, { action: 'retry' }, 'retry-command');
  assert.equal(retry?.version, 2);
  assert.equal(retry?.status, 'queued');
  assert.equal(db.command('owner', task.id, 1, { action: 'retry' }, 'retry-command')?.version, 2);
  assert.equal(db.command('owner', task.id, 1, { action: 'retry' }, 'stale-command'), undefined);
  const attempt = db.claim('owner', 'project', 'device', now + 101, 100)!;
  assert.notEqual(attempt.run.id, first.run.id);
  assert.equal(db.finish(attempt.run.id, 'device', now + 102, { status: 'failed', result: 'Failed' }), true);
  assert.equal(db.command('owner', task.id, 2, { action: 'retry' })?.version, 3);
});

test('a workflow waits for acceptance and refuses review after an upstream version changes', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  db.createWorkflow('owner', 'result-review', 'project', [
    { key: 'draft', goal: 'Draft', needs: [] },
    { key: 'review', goal: 'Review', needs: ['draft'], requireReview: true },
    { key: 'delivery', goal: 'Prepare delivery', needs: ['review'] },
  ]);
  const draft = db.claim('owner', 'project', 'device', 0, 100)!;
  assert.equal(db.finish(draft.run.id, 'device', 1, { status: 'succeeded', result: 'Draft' }), true);
  const review = db.claim('owner', 'project', 'device', 2, 100)!;
  const outcome = { status: 'succeeded' as const, result: 'Reviewed', artifact: { name: 'review.md', text: 'Proof' } };
  assert.equal(db.finish(review.run.id, 'device', 3, outcome), true);
  assert.equal(db.get('owner', review.task.id)?.status, 'waiting_review');
  assert.equal(db.claim('owner', 'project', 'device', 4, 100), undefined);
  db.command('owner', draft.task.id, 1, { action: 'append', text: 'Update the source' });
  assert.equal(db.command('owner', review.task.id, 1, { action: 'accept_result' }), undefined);
  assert.equal(db.command('owner', review.task.id, 1, { action: 'reject_result' })?.status, 'failed');
  assert.equal(db.command('owner', review.task.id, 2, { action: 'retry' })?.status, 'waiting_dependency');
  const updatedDraft = db.claim('owner', 'project', 'device', 5, 100)!;
  db.finish(updatedDraft.run.id, 'device', 6, { status: 'succeeded', result: 'Updated source' });
  const nextReview = db.claim('owner', 'project', 'device', 7, 100)!;
  db.finish(nextReview.run.id, 'device', 8, outcome);
  const accepted = db.command('owner', review.task.id, 3, { action: 'accept_result' }, 'accepted');
  assert.equal(accepted?.status, 'succeeded');
  assert.equal(accepted?.version, 4);
  assert.equal(db.command('owner', review.task.id, 3, { action: 'accept_result' }, 'accepted')?.version, 4);
  const delivery = db.claim('owner', 'project', 'device', 9, 100)!;
  assert.equal(delivery.task.goal, 'Prepare delivery');
  assert.equal(delivery.predecessors[0].version, 4);
  assert.equal(delivery.predecessors[0].artifact?.excerpt, 'Proof');
});

test('revisions invalidate completed transitive results without silently re-running them', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  db.createWorkflow('owner', 'transitive-change', 'project', [
    { key: 'draft', goal: 'Draft', needs: [] },
    { key: 'review', goal: 'Review', needs: ['draft'] },
    { key: 'publish', goal: 'Prepare publication', needs: ['review'] },
  ]);
  const draft = db.claim('owner', 'project', 'device', 0, 100)!;
  db.finish(draft.run.id, 'device', 1, { status: 'succeeded', result: 'First draft' });
  const review = db.claim('owner', 'project', 'device', 2, 100)!;
  db.finish(review.run.id, 'device', 3, { status: 'succeeded', result: 'Accepted review' });
  const publish = db.claim('owner', 'project', 'device', 4, 100)!;
  db.command('owner', draft.task.id, 1, { action: 'append', text: 'Revise the facts' });
  const stale = db.get('owner', review.task.id);
  assert.equal(stale?.status, 'waiting_user');
  assert.equal(stale?.version, 2);
  assert.equal(db.timeline('owner', review.task.id)?.events[0].type, 'workflow.result_outdated');
  assert.equal(db.renew(publish.run.id, 'device', 5, 100), undefined);
  assert.equal(db.finish(publish.run.id, 'device', 6, { status: 'succeeded', result: 'Obsolete' }), false);
  const revised = db.claim('owner', 'project', 'device', 7, 100)!;
  db.finish(revised.run.id, 'device', 8, { status: 'succeeded', result: 'Revised draft' });
  assert.equal(db.claim('owner', 'project', 'device', 9, 100), undefined);
  assert.equal(db.command('owner', review.task.id, 2, { action: 'retry' })?.status, 'queued');
  const next = db.claim('owner', 'project', 'device', 10, 100)!;
  assert.equal(next.predecessors[0].result, 'Revised draft');
});

test('claims rotate incoming channels within each owner and workspace while preserving channel FIFO', t => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const receive = (channel: string, id: string, workspace = 'project', owner = 'owner') =>
    store.receiveChannelMessage(owner, channel, workspace, { id, chat: 'chat', thread: id, root: true, text: id });
  receive('weixin', 'wx-1');
  receive('weixin', 'wx-2');
  receive('weixin', 'wx-3');
  receive('feishu', 'feishu-1');
  receive('feishu', 'feishu-other-project', 'other-project');
  receive('feishu', 'feishu-other-owner', 'project', 'other-owner');
  const desktop = store.create('owner', 'desktop', 'local', 'project', 'Local task');
  const take = (device: string, key: string, workspace = 'project', owner = 'owner') =>
    store.claim(owner, workspace, device, 1, 10_000, '', '', key)!;
  const first = take('device-a', 'first');
  assert.equal(first.task.goal, 'wx-1');
  assert.equal(take('device-a', 'first').run.id, first.run.id);
  assert.equal(take('device-a', 'different-request'), undefined);
  assert.equal(take('device-b', 'second').task.goal, 'feishu-1');
  assert.equal(take('device-e', 'third').task.id, desktop.id);
  receive('feishu', 'feishu-2');
  assert.equal(take('device-f', 'fourth').task.goal, 'wx-2');
  assert.equal(take('device-g', 'fifth').task.goal, 'feishu-2');
  assert.equal(take('device-h', 'sixth').task.goal, 'wx-3');
  assert.equal(take('device-c', 'other', 'other-project').task.goal, 'feishu-other-project');
  assert.equal(take('device-d', 'other', 'project', 'other-owner').task.goal, 'feishu-other-owner');
});

test('workspace Worker policies filter readiness, fresh assignments, and claim replay', t => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const now = Date.now();
  const agent = store.registerDevice('owner', 'Agent', 'restricted');
  const acp = { label: 'ACP agent', protocol: 'acp' };
  const codex = { label: 'Codex', protocol: 'codex' };
  store.recordDeviceWorker(agent.id, acp);
  store.recordDeviceActivity(agent.id, now, 'agent.acp');
  store.setWorkspaceWorkerPolicy('owner', 'restricted', ['codex']);
  const task = store.create('owner', 'test', 'restricted', 'restricted', 'Review notes');
  store.updateDeviceReadiness(now);
  assert.equal(store.get('owner', task.id)?.status, 'waiting_device');
  assert.equal(store.devices('owner').find(item => item.id === agent.id)?.workerPolicyBlocked, 1);
  const claim = (worker: typeof acp | undefined, key?: string) =>
    store.claim('owner', 'restricted', agent.id, now, 45_000, '', '/preview ', key, worker);
  assert.equal(claim(acp), undefined);
  assert.equal(claim(undefined), undefined);
  store.recordDeviceWorker(agent.id, codex);
  assert.equal(store.devices('owner').find(item => item.id === agent.id)?.workerPolicyBlocked, 0);
  store.updateDeviceReadiness(now);
  assert.equal(store.get('owner', task.id)?.status, 'queued');
  const assignment = claim(codex, 'claim')!;
  assert.equal(assignment.task.id, task.id);
  assert.equal(claim(codex, 'claim')?.run.id, assignment.run.id);
  store.setWorkspaceWorkerPolicy('owner', 'restricted', []);
  assert.equal(claim(codex, 'claim'), undefined);
  assert.equal(store.get('owner', task.id)?.status, 'running');
  const preview = store.create('owner', 'test', 'preview', 'restricted', '/preview notes.txt');
  assert.equal(store.claim('owner', 'restricted', 'viewer', now, 45_000, '/preview ')?.task.id, preview.id);
  const other = store.create('other', 'test', 'other', 'restricted', 'Review other notes');
  assert.equal(store.claim('other', 'restricted', 'other-device', now, 45_000)?.task.id, other.id);
});

test('workspace Worker concurrency counts active leases until the device acknowledges stopping', t => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const now = Date.now();
  const worker = { label: 'Approval fixture', protocol: 'acp' };
  store.setWorkspaceWorkerPolicy('owner', 'project', ['acp'], 1);
  const first = store.create('owner', 'fixture', 'first-slot', 'project', 'First task');
  const second = store.create('owner', 'fixture', 'second-slot', 'project', 'Second task');
  const get = (device: string, key: string) => store.claim('owner', 'project', device, now + 1, 45_000, '', '/preview ', key, worker);
  const running = get('first-device', 'first')!;
  assert.equal(running.task.id, first.id);
  assert.equal(get('second-device', 'saturated'), undefined);
  assert.equal(get('first-device', 'first')?.run.id, running.run.id);
  assert.equal(store.get('owner', second.id)?.status, 'queued');
  const preview = store.create('owner', 'fixture', 'preview-slot', 'project', '/preview notes.txt');
  assert.equal(store.claim('owner', 'project', 'preview-device', now + 1, 45_000, '/preview ')?.task.id, preview.id);
  assert.equal(store.command('owner', first.id, 1, { action: 'cancel' })?.status, 'cancelling');
  assert.equal(get('second-device', 'until-ack'), undefined);
  assert.equal(store.acknowledgeStop(running.run.id, 'first-device', now + 2), true);
  assert.equal(get('second-device', 'after-ack')?.task.id, second.id);
  assert.deepEqual(store.workspaceWorkerPolicies('owner'), [{ workspace: 'project', protocols: ['acp'], maxConcurrent: 1 }]);
});

test('an approval timeout occupies a workspace Worker slot until the original device stops', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const now = Date.now();
  const worker = { protocol: 'acp', label: 'Fixture' };
  db.setWorkspaceWorkerPolicy('owner', 'project', ['acp'], 1);
  db.create('owner', 'fixture', 'first', 'project', 'Prepare notes');
  const run = db.claim('owner', 'project', 'first', now, 400_000, '', '/preview ', undefined, worker)!.run;
  const expiry = Number(db.requestApproval(run.id, run.device, 'Review notes', now)?.expires);
  assert.equal(db.expire(expiry), 1);

  const queued = db.create('owner', 'fixture', 'second', 'project', 'Revise the document');
  const claim = () => db.claim('owner', 'project', 'second', expiry, 45_000, '', '/preview ', undefined, worker);
  assert.equal(claim(), undefined);
  assert.equal(db.acknowledgeStop(run.id, 'second', expiry), false);
  assert.equal(claim(), undefined);
  assert.equal(db.acknowledgeStop(run.id, run.device, expiry), true);
  assert.equal(claim()?.task.id, queued.id);
});

test('retry waits for an approval-timed-out run to stop even without a workspace concurrency cap', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const now = Date.now();
  const task = db.create('owner', 'fixture', 'approval-retry', 'project', 'Prepare notes');
  const run = db.claim('owner', 'project', 'first', now, 400_000)!.run;
  const expiry = Number(db.requestApproval(run.id, run.device, 'Review notes', now)?.expires);
  assert.equal(db.expire(expiry), 1);
  assert.equal(db.command('owner', task.id, task.version, { action: 'retry' })?.version, task.version + 1);

  assert.equal(db.snapshot('owner').tasks.find(item => item.id === task.id)?.waitingForPreviousRun, true);
  const unrelated = db.create('owner', 'fixture', 'unrelated', 'project', 'Read another file');
  const claim = (device: string) => db.claim('owner', 'project', device, expiry, 45_000);
  assert.equal(claim('other-device')?.task.id, unrelated.id);
  assert.equal(claim('replacement-device'), undefined);
  assert.ok(db.acknowledgeStop(run.id, run.device, expiry));
  assert.equal(db.snapshot('owner').tasks.find(item => item.id === task.id)?.waitingForPreviousRun, undefined);
  assert.equal(db.timeline('owner', task.id)?.events[0].type, 'run.stop_confirmed');
  const retry = claim('replacement-device');
  assert.equal(retry?.task.id, task.id);
  assert.equal(retry?.run.version, task.version + 1);
});

test('routing decisions and task creation commit together', t => {
  const dir = mkdtempSync(join(tmpdir(), 'blazar-route-commit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'router.sqlite');
  const input = { workspace: 'project', text: 'Review the report' };
  const db = new TaskStore(path);
  try {
    db.create('owner', 'conversation', 'conflicting-key', 'project', 'Original goal');
    assert.throws(() => db.persistRoutingDecision('owner', 'admin', 'conflicting-key', input, { kind: 'create_task' }),
      /Idempotency key already used/);
    assert.equal(db.routingDecision('owner', 'conflicting-key', input), undefined);
    db.persistRoutingDecision('owner', 'admin', 'fresh-key', input, { kind: 'create_task' });
  } finally {
    db.close();
  }
  const reopened = new TaskStore(path);
  try {
    assert.deepEqual(reopened.routingDecision('owner', 'fresh-key', input), { kind: 'create_task' });
    const task = reopened.snapshot('owner').tasks.find(task => task.goal === input.text);
    assert.ok(task);
    assert.equal(reopened.create('owner', 'conversation', 'fresh-key', input.workspace, input.text).id, task.id);
  } finally {
    reopened.close();
  }
});

test('task command receipts distinguish callers sharing an owner and key', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const task = db.create('owner', 'fixture', 'task', 'project', 'Review report');
  const append = { action: 'append', text: 'Check the sources' } as const;
  assert.equal(db.command('owner', task.id, 1, append, 'command-key')?.version, 2);
  assert.equal(db.command('owner', task.id, 2, append, 'command-key', 'phone-one')?.version, 3);
  assert.equal(db.command('owner', task.id, 3, append, 'command-key', 'phone-two')?.version, 4);
  assert.equal(db.command('owner', task.id, 2, append, 'command-key', 'phone-one')?.version, 3);
  assert.throws(() => db.command('owner', task.id, 4, append, 'command-key', 'phone-one'),
    /Idempotency key already used/);
  assert.equal(db.get('owner', task.id)?.version, 4);
});

test('IM retry is limited to a linked task and deduplicated by channel message ID', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const send = (id: string, text: string, root = false, chat = 'linked-chat') =>
    db.receiveChannelMessage('owner', 'feishu', 'project', { id, text, chat, thread: 'root', root });
  send('unbound-command', '/重试', true);
  assert.equal(db.snapshot('owner').tasks.length, 0);
  send('root', 'Review notes', true);
  const [task] = db.snapshot('owner').tasks;
  const now = Date.now();
  const { run } = db.claim('owner', 'project', 'device', now, 45_000)!;
  assert.equal(db.finish(run.id, run.device, now, { status: 'failed', result: 'Fixture failed' }), true);
  send('wrong-chat', '/retry', false, 'other-chat');
  assert.equal(db.get('owner', task.id)?.status, 'failed');
  send('follow-up', '/重试');
  send('follow-up', '/重试');
  assert.equal(db.get('owner', task.id)?.status, 'queued');
  assert.equal(db.get('owner', task.id)?.version, task.version + 1);
  assert.equal(db.timeline('owner', task.id)?.events.filter(event => event.type === 'task.retry_requested').length, 1);
});

test('IM result review requires the current version of a linked task', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const now = Date.now();
  db.createWorkflow('owner', 'review-flow', 'project', [
    { key: 'draft', goal: 'Draft notes', needs: [], requireReview: true },
    { key: 'next', goal: 'Summarize notes', needs: ['draft'] },
  ]);
  const { task, run } = db.claim('owner', 'project', 'device', now, 45_000)!;
  assert.equal(db.finish(run.id, run.device, now, { status: 'succeeded', result: 'Draft' }), true);
  const code = db.createTaskLink('owner', task.id, now)!.code;
  const send = (id: string, text: string, root = false) =>
    db.receiveChannelMessage('owner', 'feishu', 'project', { id, text, chat: 'chat', thread: 'root', root });
  send('root', '/link ' + code, true);
  send('missing-version', '/accept');
  send('wrong-version', '/accept 2');
  assert.equal(db.get('owner', task.id)?.status, 'waiting_review');
  send('accept', '/验收 1');
  send('accept', '/验收 1');
  assert.equal(db.get('owner', task.id)?.status, 'succeeded');
  assert.equal(db.get('owner', task.id)?.version, 2);
  assert.equal(db.timeline('owner', task.id)?.events.filter(event => event.type === 'task.result_accepted').length, 1);
  assert.equal(db.claim('owner', 'project', 'device', now, 45_000)?.task.goal, 'Summarize notes');
});

test('IM review result uses the fresh passive reply window after the linked window closes', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const now = Date.now();
  db.createWorkflow('owner', 'flow', 'project', [{ key: 'draft', goal: 'Draft notes', needs: [], requireReview: true }]);
  const { task, run } = db.claim('owner', 'project', 'device', now, 45_000)!;
  const code = db.createTaskLink('owner', task.id, now)!.code;
  db.receiveChannelMessage('owner', 'qq', 'project', {
    id: 'root', chat: 'chat', thread: 'root', root: true, text: '/link ' + code, replyExpires: now - 1,
  });
  assert.ok(db.finish(run.id, run.device, now, { status: 'succeeded', result: 'Private draft' }));
  db.receiveChannelMessage('owner', 'qq', 'project', {
    id: 'review', chat: 'chat', thread: 'root', root: false, text: '/accept 1', replyExpires: now + 60_000,
  });
  const notice = db.leasePassiveNotice('qq', Date.now(), ['chat']);
  assert.equal(notice?.messageId, 'review');
  assert.match(notice?.text ?? '', /completed/);
  assert.doesNotMatch(notice?.text ?? '', /Private draft/);
  assert.equal(db.leasePassiveNotice('qq', Date.now(), ['chat']), undefined);
});

test('IM cancellation confirmation uses the stop request reply window after device acknowledgement', t => {
  const db = new TaskStore(':memory:');
  t.after(() => db.close());
  const now = Date.now();
  db.receiveChannelMessage('owner', 'qq', 'project', {
    id: 'root', chat: 'chat', thread: 'root', root: true, text: 'Review notes', replyExpires: now - 1,
  });
  const { task, run } = db.claim('owner', 'project', 'device', now, 45_000)!;
  db.receiveChannelMessage('owner', 'qq', 'project', {
    id: 'cancel', chat: 'chat', thread: 'root', root: false, text: '/cancel', replyExpires: now + 60_000,
  });
  assert.equal(db.get('owner', task.id)?.status, 'cancelling');
  assert.equal(db.leasePassiveNotice('qq', Date.now(), ['chat']), undefined);
  assert.ok(db.acknowledgeStop(run.id, run.device, now + 1));
  const notice = db.leasePassiveNotice('qq', Date.now(), ['chat']);
  assert.equal(notice?.messageId, 'cancel');
  assert.match(notice?.text ?? '', /cancelled/);
  assert.equal(db.leasePassiveNotice('qq', Date.now(), ['chat']), undefined);
});
