import type { DatabaseSync } from 'node:sqlite';
import type { Task, TaskEvent } from '../../../packages/protocol/task.ts';
import { sqliteTransaction } from '../../../packages/storage/sqlite.ts';
import type { ConversationTurn, Decision } from '../harness.ts';

export class TaskReadRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(owner: string, taskId: string): Task | undefined {
    return this.db.prepare('SELECT * FROM task WHERE owner=? AND id=?').get(owner, taskId) as unknown as Task | undefined;
  }

  eventCursor(): number {
    const row = this.db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='event'),0) AS cursor").get();
    return Number(row?.cursor);
  }

  eventReplayFloor(): number {
    return Number(this.db.prepare('SELECT replay_floor FROM event_retention WHERE id=1').get()?.replay_floor ?? 0);
  }

  snapshot(owner: string) {
    return sqliteTransaction(this.db, () => {
      const rows = this.db.prepare('SELECT * FROM task WHERE owner=? ORDER BY rowid DESC').all(owner) as unknown as Task[];
      const pendingStops = new Set(this.db.prepare(`SELECT s.task_id FROM expired_approval_stop s
        JOIN task t ON t.id=s.task_id WHERE t.owner=? AND s.expires>?`).all(owner, Date.now()).map(row => row.task_id));
      const reconciliation = new Set(this.db.prepare(`SELECT r.task_id FROM desktop_reconciliation r
        JOIN task t ON t.id=r.task_id WHERE t.owner=?`).all(owner).map(row => row.task_id));
      const tasks = rows.map(task => ({
        ...task,
        ...(pendingStops.has(task.id) && ['queued', 'waiting_device'].includes(task.status) && { waitingForPreviousRun: true }),
        ...(task.status === 'waiting_user' && reconciliation.has(task.id) && { desktopReconciliationRequired: true }),
      }));
      const cursor = this.eventCursor();
      const artifacts = this.db.prepare(`SELECT a.id,a.taskId,a.runId,a.name,a.sha256,a.size,
        CASE WHEN i.artifact_id IS NOT NULL THEN 'image/png' END AS mime,i.expires,v.task_version AS version
        FROM artifact a JOIN task t ON t.id=a.taskId LEFT JOIN artifact_image i ON i.artifact_id=a.id
        LEFT JOIN artifact_version v ON v.artifact_id=a.id
        WHERE t.owner=? AND (i.expires IS NULL OR i.expires>?) ORDER BY a.rowid DESC`).all(owner, Date.now());
      const approvals = this.db.prepare(`SELECT a.id,a.taskId,a.version,a.summary,a.expires
        FROM approval a JOIN task t ON t.id=a.taskId JOIN run r ON r.id=a.runId
        WHERE NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id)
        AND t.owner=? AND t.status='waiting_user' AND a.version=t.version AND a.decision IS NULL
        AND a.expires>? AND r.expires>? ORDER BY a.rowid DESC`).all(owner, Date.now(), Date.now());
      const progress = this.db.prepare(`SELECT r.taskId,r.id AS runId,
        CASE WHEN a.stalled=1 THEN 'No recent Worker output. The run is still active.' ELSE p.message END AS message
        FROM run r JOIN task t ON t.id=r.taskId JOIN run_activity a ON a.run_id=r.id
        LEFT JOIN run_progress p ON p.run_id=r.id
          AND p.device_seq=(SELECT MAX(device_seq) FROM run_progress WHERE run_id=r.id)
        WHERE t.owner=? AND t.status='running' AND r.version=t.version
        AND (p.device_seq IS NOT NULL OR a.stalled=1)`).all(owner);
      const workflowSteps = this.db.prepare(`SELECT s.workflow_id AS workflowId,s.step_key AS stepKey,
        s.task_id AS taskId,d.predecessor AS predecessorId,a.device_id AS workerDeviceId FROM workflow_step s
        JOIN workflow w ON w.id=s.workflow_id LEFT JOIN workflow_dependency d ON d.task_id=s.task_id
        LEFT JOIN task_worker_device a ON a.task_id=s.task_id
        WHERE w.owner=? ORDER BY s.rowid`).all(owner).map(({ workerDeviceId, ...step }) =>
          workerDeviceId ? { ...step, workerDeviceId } : step);
      const criteria = this.db.prepare(`SELECT c.task_id AS taskId,c.criterion FROM task_criterion c
        JOIN task t ON t.id=c.task_id WHERE t.owner=? ORDER BY c.task_id,c.position`).all(owner);
      const attachments = this.db.prepare(`SELECT a.task_id AS taskId,a.position,a.name,length(CAST(a.text AS BLOB)) AS size
        FROM task_attachment a JOIN task t ON t.id=a.task_id WHERE t.owner=? ORDER BY a.task_id,a.position`).all(owner);
      const completedSchedules = this.db.prepare(`SELECT r.workflow_id AS workflowId,s.label,
        (SELECT step.task_id FROM workflow_step step WHERE step.workflow_id=r.workflow_id
          ORDER BY step.rowid DESC LIMIT 1) AS taskId
        FROM workflow_schedule_run r JOIN workflow_schedule s ON s.id=r.schedule_id
        WHERE s.owner=? AND NOT EXISTS (
          SELECT 1 FROM workflow_step step JOIN task t ON t.id=step.task_id
          WHERE step.workflow_id=r.workflow_id AND t.status<>'succeeded'
        ) ORDER BY r.rowid DESC LIMIT 50`).all(owner);
      return { tasks, artifacts, attachments, approvals, progress, workflowSteps, criteria, completedSchedules, cursor };
    });
  }

  taskAttachment(owner: string, taskId: string, position: number) {
    return this.db.prepare(`SELECT a.name,a.text FROM task_attachment a JOIN task t ON t.id=a.task_id
      WHERE t.owner=? AND a.task_id=? AND a.position=?`).get(owner, taskId, position);
  }

  artifact(owner: string, id: string, now = Date.now()) {
    return this.db.prepare(`SELECT a.taskId,a.name,a.sha256,a.content,v.task_version AS version,
      CASE WHEN i.artifact_id IS NOT NULL THEN 'image/png' END AS mime FROM artifact a
      JOIN task t ON t.id=a.taskId LEFT JOIN artifact_image i ON i.artifact_id=a.id
      LEFT JOIN artifact_version v ON v.artifact_id=a.id
      WHERE t.owner=? AND a.id=? AND (i.expires IS NULL OR i.expires>?)`).get(owner, id, now) as
      { taskId: string; name: string; sha256: string; content: Uint8Array; mime: 'image/png' | null; version: number | null } | undefined;
  }

  latestTaskText(taskId: string, version: number) {
    const row = this.db.prepare(`SELECT a.name,substr(CAST(a.content AS TEXT),1,1800) AS excerpt,a.size
      FROM artifact a JOIN artifact_version v ON v.artifact_id=a.id
      WHERE a.taskId=? AND v.task_version=? AND NOT EXISTS(
        SELECT 1 FROM artifact_image i WHERE i.artifact_id=a.id
      ) ORDER BY a.rowid DESC LIMIT 1`).get(taskId, version);
    return row ? { name: String(row.name), excerpt: String(row.excerpt).toWellFormed(), size: Number(row.size) } : undefined;
  }

  timeline(owner: string, taskId: string, before?: number) {
    if (!this.get(owner, taskId)) return undefined;
    const rows = this.db.prepare(`SELECT seq,type,data FROM event
      WHERE taskId=? AND (? IS NULL OR seq<?) ORDER BY seq DESC LIMIT 51`)
      .all(taskId, before ?? null, before ?? null);
    const page = rows.slice(0, 50);
    return {
      events: page.map(row => ({ seq: Number(row.seq), type: String(row.type), data: JSON.parse(String(row.data)) })),
      before: rows.length > 50 ? Number(page.at(-1)?.seq) : null,
    };
  }

  recentTaskEventTypes(owner: string, workspace: string, taskId: string) {
    return this.db.prepare(`SELECT e.seq,e.type FROM event e JOIN task t ON t.id=e.taskId
      WHERE t.owner=? AND t.workspace=? AND t.id=? ORDER BY e.seq DESC LIMIT 20`)
      .all(owner, workspace, taskId).reverse().map(row => ({ seq: Number(row.seq), type: String(row.type) }));
  }

  events(owner: string, after: number, through = Number.MAX_SAFE_INTEGER): TaskEvent[] {
    return this.db.prepare(`SELECT e.* FROM event e JOIN task t ON e.taskId=t.id
      WHERE t.owner=? AND e.seq>? AND e.seq<=? ORDER BY e.seq LIMIT 100`).all(owner, after, through) as unknown as TaskEvent[];
  }

  findRouterTasks(owner: string, workspace: string, query: string, includeAppEvidence = false) {
    return this.db.prepare(`SELECT id,substr(goal,1,320) AS goal,status,version,
      (SELECT workflow_id FROM workflow_step WHERE task_id=task.id) AS workflow_id,
      (SELECT step_key FROM workflow_step WHERE task_id=task.id) AS step_key,
      (SELECT json_group_array(protocol ORDER BY protocol) FROM task_worker_protocol WHERE task_id=task.id) AS protocols
      FROM task WHERE owner=? AND workspace=?
      AND (?='' OR id=? OR instr(lower(goal),lower(?))>0)
      AND (? OR NOT EXISTS(SELECT 1 FROM task_app_evidence e WHERE e.task_id=task.id))
      ORDER BY rowid DESC LIMIT 8`).all(owner, workspace, query, query, query, Number(includeAppEvidence))
      .map(row => {
        const workerProtocols = JSON.parse(String(row.protocols)) as string[];
        return {
          id: String(row.id), goal: String(row.goal).toWellFormed(),
          status: String(row.status), version: Number(row.version),
          ...(typeof row.workflow_id === 'string' && typeof row.step_key === 'string' &&
            { workflowId: row.workflow_id, stepKey: row.step_key }),
          ...(workerProtocols.length && { workerProtocols }),
        };
      });
  }

  recentConversation(owner: string, workspace: string, caller = 'admin'): ConversationTurn[] {
    return this.db.prepare(`SELECT json_extract(request,'$[1]') AS text,decision,(
        SELECT json_group_array(json_array(e.task_id,e.version)) FROM routing_task_evidence e
        WHERE e.owner=r.owner AND e.caller=r.caller AND e.request_key=r.key
      ) AS evidence FROM routing_decision r
      WHERE r.owner=? AND r.caller=? AND json_extract(request,'$[0]')=? AND json_array_length(request)=2
      AND NOT EXISTS(SELECT 1 FROM routing_task_evidence e LEFT JOIN task t ON t.id=e.task_id
        WHERE e.owner=r.owner AND e.caller=r.caller AND e.request_key=r.key
        AND (t.status IS NOT 'succeeded' OR t.version IS NOT e.version))
      AND NOT (
        json_extract(request,'$[1]') IN ('/status','/状态')
        OR json_extract(request,'$[1]') GLOB '/status *' OR json_extract(request,'$[1]') GLOB '/状态 *'
      ) ORDER BY rowid DESC LIMIT 6`)
      .all(owner, caller, workspace).reverse().map(row => {
        const decision = JSON.parse(String(row.decision)) as Decision;
        if (decision.kind === 'propose_workflow') {
          decision.text = decision.text.slice(0, 2_000);
          decision.steps = decision.steps.map(step => ({ ...step, goal: step.goal.slice(0, 200) }));
        } else if (decision.kind === 'append_task') {
          decision.text = decision.text.slice(0, 2_000);
          decision.instruction = decision.instruction.slice(0, 2_000);
        } else if (decision.kind !== 'create_task') decision.text = decision.text.slice(0, 2_000);
        else if (decision.goal) decision.goal = decision.goal.slice(0, 2_000);
        const taskEvidence = JSON.parse(String(row.evidence)) as [string, number][];
        return { text: String(row.text).slice(0, 2_000), decision, ...(taskEvidence.length && { taskEvidence }) };
      });
  }
}
