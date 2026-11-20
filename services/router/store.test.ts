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
  assert.equal(db.renew(run.id, 'device', 5, 10), false);
  assert.equal(db.expire(10), 1);
  assert.equal(db.finish(run.id, 'device', 11, { status: 'succeeded', result: 'Late' }), false);
  assert.equal(db.get('owner', task.id)?.status, 'cancelled');
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
  assert.equal(db.requestApproval(run.id, 'device', 'A different action', now), undefined);
  assert.equal(db.snapshot('owner').approvals.length, 1);
  assert.equal(db.snapshot('other').approvals.length, 0);
  assert.equal(db.finish(run.id, 'device', now, { status: 'succeeded', result: 'Premature' }), false);
  assert.equal(db.renew(run.id, 'device', now + 1, 45_000), true);
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
  assert.equal(db.renew(run.id, 'device', expiry + 1, 45_000), false);
  assert.equal(db.finish(run.id, 'device', expiry + 1, { status: 'succeeded', result: 'Late' }), false);
  assert.equal(db.consumeApproval(run.id, 'device', String(approval.id), expiry + 1), false);
  const events = db.events('owner', cursor);
  assert.deepEqual(events.map(event => event.type), ['approval.expired']);
  assert.equal(JSON.parse(events[0].data).approvalId, approval.id);
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
  assert.equal(db.finish(draft.run.id, 'author', now + 1, { status: 'succeeded', result: 'First draft' }), true);
  const review = db.claim('owner', 'project', 'reviewer', now + 2, 100)!;
  const approval = db.requestApproval(review.run.id, 'reviewer', 'Approve the review', now + 3)!;
  assert.equal(db.command('owner', draft.task.id, 1, { action: 'append', text: 'Replace the draft' })?.version, 2);
  assert.equal(db.snapshot('owner').approvals.length, 0);
  assert.equal(db.command('owner', review.task.id, 1, { action: 'approve', approvalId: String(approval.id) }), undefined);
  assert.equal(db.renew(review.run.id, 'reviewer', now + 4, 100), false);
  const revised = db.claim('owner', 'project', 'author', now + 5, 100)!;
  assert.equal(db.finish(revised.run.id, 'author', now + 6, { status: 'succeeded', result: 'Revised draft' }), true);
  assert.equal(db.finish(review.run.id, 'reviewer', now + 7, {
    status: 'succeeded', result: 'Stale review', artifact: { name: 'review.txt', text: 'Old facts' },
  }), false);
  assert.equal(db.snapshot('owner').artifacts.length, 0);
  assert.equal(db.get('owner', review.task.id)?.status, 'waiting_user');
  assert.equal(db.claim('owner', 'project', 'reviewer', now + 8, 100), undefined);
  db.command('owner', review.task.id, 1, { action: 'append', text: 'Review the revised draft' });
  const retry = db.claim('owner', 'project', 'reviewer', now + 9, 100)!;
  assert.deepEqual(retry.predecessors.map(input => input.result), ['Revised draft']);
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
  assert.equal(db.renew(live.run.id, device.id, 2, 100), true);
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
  assert.equal(db.renew(first.run.id, 'device', 11, 100), false);
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
