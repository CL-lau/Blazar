import type { DatabaseSync } from 'node:sqlite';
import type { Task, WorkerConfiguration } from '../../../packages/protocol/task.ts';
import { IdempotencyConflict } from '../domain/idempotency.ts';

interface ClaimSelection {
  owner: string;
  workspace: string;
  device: string;
  now: number;
  goalPrefix: string;
  excludingPrefix: string;
  requestId?: string;
  worker?: WorkerConfiguration;
  desktopApps?: string[];
  allowWorkerInputs: boolean;
}

export class DispatchRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  select({ owner, workspace, device, now, goalPrefix, excludingPrefix, requestId,
           worker, desktopApps, allowWorkerInputs }: ClaimSelection) {
    const identity = [owner, workspace, goalPrefix, excludingPrefix];
    const fingerprint = JSON.stringify(desktopApps ? [...identity, desktopApps] : worker ? [...identity, worker] : identity);
    const policy = this.db.prepare('SELECT protocols,max_concurrent,run_limit_seconds,require_read_only FROM workspace_worker_policy WHERE owner=? AND workspace=?')
      .get(owner, workspace);
    const capabilities = JSON.stringify(worker?.capabilities ?? []);
    const workerPermitted = !policy || (worker && (JSON.parse(String(policy.protocols)) as string[]).includes(worker.protocol) &&
      (policy.require_read_only !== 1 || worker.capabilities?.includes('read-only')));
    if (requestId) {
      const receipt = this.db.prepare('SELECT fingerprint,response,expires FROM device_claim WHERE device=? AND key=?')
        .get(device, requestId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new IdempotencyConflict();
        if (!receipt.response || Number(receipt.expires) <= now) return undefined;
        const assignment = JSON.parse(String(receipt.response));
        const current = this.db.prepare(`SELECT r.expires AS expires FROM run r JOIN task t ON r.taskId=t.id
          WHERE r.id=? AND r.device=? AND r.expires>? AND r.version=t.version AND t.status='running'
          AND NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id)
          AND NOT EXISTS(SELECT 1 FROM task_worker_capability wc WHERE wc.task_id=t.id
            AND NOT EXISTS(SELECT 1 FROM json_each(?) WHERE value=wc.capability))
          AND NOT EXISTS(SELECT 1 FROM run_evidence_stop s WHERE s.run_id=r.id)
          AND (NOT EXISTS(SELECT 1 FROM task_worker_protocol wp WHERE wp.task_id=t.id) OR
            EXISTS(SELECT 1 FROM task_worker_protocol wp WHERE wp.task_id=t.id AND wp.protocol=?))
          AND (? OR substr(t.goal,1,9) IN ('/observe ','/preview ') OR substr(t.goal,1,7)='/click ')
          AND (? OR (
            NOT EXISTS(SELECT 1 FROM task_app_evidence e WHERE e.task_id=t.id)
            AND NOT EXISTS(SELECT 1 FROM task_memory_input m WHERE m.task_id=t.id)
            AND NOT EXISTS(SELECT 1 FROM task_attachment a WHERE a.task_id=t.id)))`)
          .get(assignment.run.id, device, now, capabilities, worker?.protocol ?? null, Number(Boolean(workerPermitted)), Number(allowWorkerInputs));
        if (!current) return undefined;
        assignment.run.expires = Number(current.expires);
        return { kind: 'replay' as const, assignment: assignment as unknown };
      }
    }
    if (this.db.prepare('SELECT 1 FROM device_pause WHERE device_id=?').get(device)) return undefined;
    if (this.db.prepare(`SELECT 1 FROM run WHERE device=? AND expires>?
      UNION ALL SELECT 1 FROM expired_approval_stop WHERE device_id=? AND expires>? LIMIT 1`)
      .get(device, now, device, now)) return undefined;
    let workerHasCapacity = true;
    if (goalPrefix !== '/preview ' && goalPrefix !== '/observe ') {
      const active = this.db.prepare(`WITH occupied AS (
        SELECT id,taskId AS task_id,expires FROM run
        UNION ALL SELECT run_id,task_id,expires FROM expired_approval_stop
      )
        SELECT COUNT(*) AS count, COUNT(*) FILTER (WHERE NOT EXISTS(
          SELECT 1 FROM event e, json_each(e.data,'$.worker.capabilities') capability
          WHERE e.taskId=t.id AND e.type='run.started' AND json_extract(e.data,'$.runId')=r.id
          AND capability.value='git-worktree'
        )) AS exclusive_count FROM occupied r JOIN task t ON t.id=r.task_id
        WHERE t.owner=? AND t.workspace=? AND r.expires>?
        AND substr(t.goal,1,9) NOT IN ('/observe ','/preview ') AND substr(t.goal,1,7)<>'/click '`)
        .get(owner, workspace, now);
      const count = Number(active?.count);
      workerHasCapacity = (policy?.max_concurrent == null || count < Number(policy.max_concurrent)) &&
        (count === 0 || (worker?.capabilities?.includes('git-worktree') === true && Number(active?.exclusive_count) === 0));
    }
    const task = this.db.prepare(`WITH eligible AS (
      SELECT task.rowid AS queue_order, task.*, COALESCE((
        SELECT json_extract(e.data,'$.channel') FROM event e
        WHERE e.taskId=task.id AND e.type='task.created' ORDER BY e.seq LIMIT 1
      ), '') AS origin_channel
      FROM task WHERE owner=? AND workspace=?
      AND status IN ('queued','waiting_device') AND (substr(goal,1,length(?))=? OR (?='/observe ' AND substr(goal,1,7)='/click '))
      AND (?='' OR (substr(goal,1,length(?))!=? AND substr(goal,1,9)!='/observe ' AND substr(goal,1,7)!='/click '))
      AND NOT EXISTS(SELECT 1 FROM stale_workflow_step stale WHERE stale.task_id=task.id)
      AND NOT EXISTS(SELECT 1 FROM expired_approval_stop s WHERE s.task_id=task.id AND s.expires>?)
      AND NOT EXISTS(SELECT 1 FROM task_worker_capability wc WHERE wc.task_id=task.id
        AND NOT EXISTS(SELECT 1 FROM json_each(?) WHERE value=wc.capability))
      AND (NOT EXISTS(SELECT 1 FROM task_worker_protocol wp WHERE wp.task_id=task.id) OR
        EXISTS(SELECT 1 FROM task_worker_protocol wp WHERE wp.task_id=task.id AND wp.protocol=?))
      AND NOT EXISTS(SELECT 1 FROM task_question_worker q WHERE q.task_id=task.id
        AND (q.device_id<>? OR ? IS NOT 'jsonl' OR q.revision IS NOT ?))
      AND NOT EXISTS(SELECT 1 FROM task_desktop_device target WHERE target.task_id=task.id AND target.device_id<>?)
      AND (? OR substr(task.goal,1,9) IN ('/observe ','/preview ') OR substr(task.goal,1,7)='/click ')
      AND (? OR (
        NOT EXISTS(SELECT 1 FROM task_app_evidence e WHERE e.task_id=task.id)
        AND NOT EXISTS(SELECT 1 FROM task_memory_input m WHERE m.task_id=task.id)
        AND NOT EXISTS(SELECT 1 FROM task_attachment a WHERE a.task_id=task.id)))
      AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(?) j WHERE
        substr(goal || ' ',1,length('/observe ' || j.value || ' '))='/observe ' || j.value || ' '
        OR substr(goal || ' ',1,length('/click ' || j.value || ' '))='/click ' || j.value || ' '))
      AND NOT EXISTS (
        SELECT 1 FROM workflow_dependency d JOIN task p ON p.id=d.predecessor
        WHERE d.task_id=task.id AND p.status!='succeeded'
      )
    )
    SELECT eligible.* FROM eligible LEFT JOIN channel_dispatch d
      ON d.owner=eligible.owner AND d.workspace=eligible.workspace AND d.channel=eligible.origin_channel
      AND d.goal_prefix=? AND d.excluding_prefix=?
    ORDER BY COALESCE(d.last_dispatch,0), eligible.queue_order LIMIT 1`).get(
      owner, workspace, goalPrefix, goalPrefix, goalPrefix, excludingPrefix, excludingPrefix, excludingPrefix, now, capabilities, worker?.protocol ?? null, device, worker?.protocol ?? null, worker?.revision ?? null, device, Number(Boolean(workerPermitted) && workerHasCapacity), Number(allowWorkerInputs),
      desktopApps ? JSON.stringify(desktopApps) : null, desktopApps ? JSON.stringify(desktopApps) : null,
      goalPrefix, excludingPrefix) as unknown as (Task & { origin_channel: string }) | undefined;
    if (!task) {
      if (requestId) this.saveReceipt(device, requestId, fingerprint, null, now);
      return undefined;
    }
    return { kind: 'selected' as const, task, fingerprint, requireReadOnly: policy?.require_read_only === 1,
      workerLimitSeconds: policy?.run_limit_seconds == null ? undefined : Number(policy.run_limit_seconds) };
  }

  saveReceipt(device: string, requestId: string, fingerprint: string, assignment: string | null, now: number) {
    this.db.prepare('INSERT INTO device_claim VALUES(?,?,?,?,?)')
      .run(device, requestId, fingerprint, assignment, now + 10 * 60_000);
  }

  markDispatched(owner: string, workspace: string, goalPrefix: string, excludingPrefix: string, channel: string, cursor: number) {
    this.db.prepare(`INSERT INTO channel_dispatch VALUES(?,?,?,?,?,?) ON CONFLICT
      (owner,workspace,goal_prefix,excluding_prefix,channel) DO UPDATE SET last_dispatch=excluded.last_dispatch`)
      .run(owner, workspace, goalPrefix, excludingPrefix, channel, cursor);
  }
}
