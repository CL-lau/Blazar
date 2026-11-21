import type { PushKind, PushResult } from '../../packages/notifications/apns.ts';
import { orderWorkflow } from './workflow.ts';
import type { ConversationTurn, Decision, RouteRequest } from './harness.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { DesktopAppControls, PredecessorInput, Run, RunOutcome, Task, TaskEvent, TaskMemoryInput, WorkerConfiguration, WorkflowStep } from '../../packages/protocol/task.ts';
import { displayTaskStatus, windowImageLifetimeMs } from '../../packages/protocol/task.ts';

const runLimitMs = 10 * 60_000;

export type AppEvidence = { query: string; sources: string[]; refs: { id: string; version: number }[] };

export class IdempotencyConflict extends Error {
  constructor() { super('Idempotency key already used'); }
}

export class TaskStore {
  private db: DatabaseSync;
  private readonly canUseChannelAppEvidence?: (owner: string, workspace: string, refs: AppEvidence['refs']) => boolean;

  constructor(path: string, canUseChannelAppEvidence?: TaskStore['canUseChannelAppEvidence']) {
    this.canUseChannelAppEvidence = canUseChannelAppEvidence;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS task (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace TEXT NOT NULL,
        goal TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'queued', result TEXT
      );
      CREATE TABLE IF NOT EXISTS channel_cursor (
        channel TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_link_code (
        code_hash TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
        expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channel_thread (
        owner TEXT NOT NULL, channel TEXT NOT NULL, chat TEXT NOT NULL, thread TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES task(id), PRIMARY KEY(owner,channel,chat,thread)
      );
      CREATE TABLE IF NOT EXISTS channel_outbox (
        id TEXT PRIMARY KEY, channel TEXT NOT NULL, chat TEXT NOT NULL, message_id TEXT NOT NULL,
        text TEXT NOT NULL, created INTEGER NOT NULL, retry INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS channel_notice_thread ON channel_outbox(channel,chat,message_id,created);
      CREATE INDEX IF NOT EXISTS channel_outbox_pending ON channel_outbox(channel,delivered,retry);
      CREATE TABLE IF NOT EXISTS channel_notice_binding (
        notice TEXT PRIMARY KEY REFERENCES channel_outbox(id) ON DELETE CASCADE,
        owner TEXT NOT NULL, channel TEXT NOT NULL, chat TEXT NOT NULL, thread TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS weixin_reply_context (
        owner TEXT NOT NULL, channel TEXT NOT NULL, chat TEXT NOT NULL,
        token TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(owner,channel,chat)
      );
      CREATE INDEX IF NOT EXISTS weixin_reply_context_expiry ON weixin_reply_context(expires);
      CREATE TABLE IF NOT EXISTS channel_reply_window (
        channel TEXT NOT NULL, chat TEXT NOT NULL, message_id TEXT NOT NULL, expires INTEGER NOT NULL,
        PRIMARY KEY(channel,chat,message_id)
      );
      CREATE TABLE IF NOT EXISTS channel_message (
        owner TEXT NOT NULL, channel TEXT NOT NULL, message TEXT NOT NULL,
        PRIMARY KEY(owner,channel,message)
      );
      CREATE TABLE IF NOT EXISTS workflow (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, UNIQUE(owner,request_key)
      );
      CREATE TABLE IF NOT EXISTS workflow_step (
        workflow_id TEXT NOT NULL REFERENCES workflow(id), step_key TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE REFERENCES task(id), PRIMARY KEY(workflow_id,step_key)
      );
      CREATE TABLE IF NOT EXISTS task_review (
        task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS review_input (
        task_id TEXT NOT NULL REFERENCES task_review(task_id) ON DELETE CASCADE,
        predecessor TEXT NOT NULL REFERENCES task(id), version INTEGER NOT NULL,
        PRIMARY KEY(task_id,predecessor)
      );
      CREATE TABLE IF NOT EXISTS task_criterion (
        task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, criterion TEXT NOT NULL, PRIMARY KEY(task_id,position)
      );
      CREATE TABLE IF NOT EXISTS workflow_dependency (
        task_id TEXT NOT NULL REFERENCES task(id), predecessor TEXT NOT NULL REFERENCES task(id),
        PRIMARY KEY(task_id,predecessor)
      );
      CREATE INDEX IF NOT EXISTS workflow_predecessor ON workflow_dependency(predecessor,task_id);
      CREATE TABLE IF NOT EXISTS mobile_pairing (
        code_hash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mobile_pairing_request (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
        expires INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','approved','denied'))
      );
      CREATE TABLE IF NOT EXISTS mobile_pairing_receipt (
        code_hash TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES mobile_pairing_request(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS mobile_client (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mobile_result_grant (
        client_id TEXT NOT NULL REFERENCES mobile_client(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES task(id), task_version INTEGER NOT NULL,
        PRIMARY KEY(client_id,task_id)
      );
      CREATE TABLE IF NOT EXISTS mobile_push (
        client_id TEXT PRIMARY KEY REFERENCES mobile_client(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS push_outbox (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES mobile_push(client_id) ON DELETE CASCADE,
        kind TEXT NOT NULL, expires INTEGER NOT NULL, next_attempt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS push_approval (
        push_id TEXT PRIMARY KEY REFERENCES push_outbox(id) ON DELETE CASCADE,
        approval_id TEXT NOT NULL REFERENCES approval(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS push_outbox_due ON push_outbox(next_attempt);
      CREATE TABLE IF NOT EXISTS device (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace TEXT NOT NULL,
        name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS device_workspace ON device(owner,workspace) WHERE revoked=0;
      CREATE TABLE IF NOT EXISTS device_presence (
        device_id TEXT PRIMARY KEY REFERENCES device(id),
        last_seen INTEGER NOT NULL, capability TEXT, platform TEXT
      );
      CREATE TABLE IF NOT EXISTS device_pause (
        device_id TEXT PRIMARY KEY REFERENCES device(id)
      );
      CREATE TABLE IF NOT EXISTS device_worker (
        device_id TEXT PRIMARY KEY REFERENCES device(id), label TEXT NOT NULL, protocol TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_memory_input (
        task_id TEXT NOT NULL REFERENCES task(id), position INTEGER NOT NULL, memory_id TEXT NOT NULL,
        version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task_id,position)
      );
      CREATE TABLE IF NOT EXISTS task_app_evidence (
        task_id TEXT PRIMARY KEY REFERENCES task(id), refs TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_desktop_device (
        task_id TEXT PRIMARY KEY REFERENCES task(id), device_id TEXT NOT NULL REFERENCES device(id)
      );
      CREATE TABLE IF NOT EXISTS device_desktop_apps (
        device_id TEXT PRIMARY KEY REFERENCES device(id), aliases TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_desktop_controls (
        device_id TEXT PRIMARY KEY REFERENCES device(id), controls TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_desktop_permissions (
        device_id TEXT PRIMARY KEY REFERENCES device(id), states TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_interruption (
        device_id TEXT PRIMARY KEY REFERENCES device(id), run_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run (
        id TEXT PRIMARY KEY, taskId TEXT NOT NULL UNIQUE REFERENCES task(id),
        device TEXT NOT NULL, version INTEGER NOT NULL, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_deadline (
        run_id TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE, deadline INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_steering (
        run_id TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS run_evidence_stop (
        run_id TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS run_device ON run(device);
      CREATE TABLE IF NOT EXISTS run_dependency (
        run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
        predecessor TEXT NOT NULL REFERENCES task(id), version INTEGER NOT NULL,
        PRIMARY KEY(run_id,predecessor)
      );
      CREATE VIEW IF NOT EXISTS invalid_workflow_run AS
        SELECT r.id FROM run r WHERE EXISTS (
          SELECT 1 FROM workflow_dependency d JOIN task p ON p.id=d.predecessor
          LEFT JOIN run_dependency v ON v.run_id=r.id AND v.predecessor=p.id
          WHERE d.task_id=r.taskId AND (p.status!='succeeded' OR v.version IS NOT p.version)
        );
      CREATE TABLE IF NOT EXISTS event (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL REFERENCES task(id),
        type TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS progress_event_time (
        seq INTEGER PRIMARY KEY REFERENCES event(seq) ON DELETE CASCADE, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS progress_event_age ON progress_event_time(created_at);
      CREATE TRIGGER IF NOT EXISTS event_record_progress_time AFTER INSERT ON event
        WHEN NEW.type='run.progress'
        BEGIN
          INSERT INTO progress_event_time VALUES(NEW.seq, CAST(unixepoch('subsec') * 1000 AS INTEGER));
        END;
      CREATE TABLE IF NOT EXISTS event_retention (
        id INTEGER PRIMARY KEY CHECK(id=1), replay_floor INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channel_dispatch (
        owner TEXT NOT NULL, workspace TEXT NOT NULL, goal_prefix TEXT NOT NULL, excluding_prefix TEXT NOT NULL,
        channel TEXT NOT NULL, last_dispatch INTEGER NOT NULL,
        PRIMARY KEY(owner,workspace,goal_prefix,excluding_prefix,channel)
      );
      CREATE TABLE IF NOT EXISTS device_claim (
        device TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        response TEXT, expires INTEGER NOT NULL, PRIMARY KEY(device,key)
      );
      CREATE INDEX IF NOT EXISTS device_claim_expiry ON device_claim(expires);
      CREATE TABLE IF NOT EXISTS run_progress (
        run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
        device_seq INTEGER NOT NULL, message TEXT NOT NULL,
        PRIMARY KEY(run_id,device_seq)
      );
      CREATE TABLE IF NOT EXISTS run_receipt (
        id TEXT PRIMARY KEY, device TEXT NOT NULL, outcome_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approval (
        id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
        taskId TEXT NOT NULL REFERENCES task(id), version INTEGER NOT NULL,
        summary TEXT NOT NULL, expires INTEGER NOT NULL, decision TEXT
      );
      CREATE TABLE IF NOT EXISTS approval_use (
        id TEXT PRIMARY KEY REFERENCES approval(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS approval_expiry ON approval(expires) WHERE decision IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_approval ON approval(runId) WHERE decision IS NULL;
      CREATE TABLE IF NOT EXISTS artifact (
        id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES task(id), runId TEXT NOT NULL,
        name TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, content BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifact_image (
        artifact_id TEXT PRIMARY KEY REFERENCES artifact(id) ON DELETE CASCADE, expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifact_image_expiry ON artifact_image(expires);
      CREATE TABLE IF NOT EXISTS artifact_version (
        artifact_id TEXT PRIMARY KEY REFERENCES artifact(id) ON DELETE CASCADE, task_version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifact_task ON artifact(taskId);
      CREATE TABLE IF NOT EXISTS receipt (
        owner TEXT NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, taskId TEXT NOT NULL REFERENCES task(id),
        PRIMARY KEY(owner, source, key)
      );
      CREATE TABLE IF NOT EXISTS routing_decision (
        owner TEXT NOT NULL, key TEXT NOT NULL, request TEXT NOT NULL, decision TEXT NOT NULL,
        PRIMARY KEY(owner,key)
      );
      CREATE INDEX IF NOT EXISTS routing_workspace ON routing_decision(owner, json_extract(request,'$[0]'));
      CREATE TABLE IF NOT EXISTS command_receipt (
        owner TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        response TEXT NOT NULL, PRIMARY KEY(owner,key)
      );
      CREATE INDEX IF NOT EXISTS task_dispatch ON task(workspace,status);
      CREATE INDEX IF NOT EXISTS event_task ON event(taskId,seq);
    `);
    this.transaction(() => {
      if (this.db.prepare('INSERT OR IGNORE INTO event_retention VALUES(1,0)').run().changes) {
        this.db.prepare(`INSERT OR IGNORE INTO progress_event_time
          SELECT seq,? FROM event WHERE type='run.progress'`).run(Date.now());
      }
      this.db.prepare('INSERT OR IGNORE INTO run_deadline SELECT id,expires+? FROM run').run(runLimitMs);
      this.updateWorkflowReadiness();
    });
  }

  close() {
    this.db.close();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private updateWorkflowReadiness(changedTask?: string) {
    const updates = this.db.prepare(`WITH readiness AS MATERIALIZED (
      SELECT t.id,CASE WHEN EXISTS (
        SELECT 1 FROM workflow_dependency d JOIN task p ON p.id=d.predecessor
        WHERE d.task_id=t.id AND p.status!='succeeded'
      ) THEN 'waiting_dependency' WHEN t.status='waiting_device' THEN 'waiting_device' ELSE 'queued' END AS next_status
      FROM task t JOIN workflow_step w ON w.task_id=t.id
      WHERE t.status IN ('queued','waiting_dependency','waiting_device')
      AND (? IS NULL OR t.id=? OR EXISTS (
        SELECT 1 FROM workflow_dependency d WHERE d.predecessor=? AND d.task_id=t.id
      ))
    )
    UPDATE task SET status=readiness.next_status FROM readiness
    WHERE task.id=readiness.id AND task.status<>readiness.next_status
    RETURNING id,status`).all(changedTask ?? null, changedTask ?? null, changedTask ?? null);
    for (const update of updates) {
      this.event(String(update.id), update.status === 'queued' ? 'workflow.step_ready' : 'workflow.waiting_dependency', {
        status: update.status,
      });
    }
  }

  private invalidateCompletedDescendants(upstreamId: string) {
    const invalidated = this.db.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT task_id FROM workflow_dependency WHERE predecessor=?
      UNION
      SELECT d.task_id FROM workflow_dependency d JOIN descendants parent ON d.predecessor=parent.id
    )
    UPDATE task SET status='waiting_user',version=version+1,result=?
    WHERE status='succeeded' AND id IN (SELECT id FROM descendants)
    RETURNING id`).all(upstreamId, 'An upstream result was revised. Review prior results before retrying.');
    for (const task of invalidated) {
      this.event(String(task.id), 'workflow.result_outdated', { upstreamId, status: 'waiting_user' });
    }
    if (invalidated.length) this.updateWorkflowReadiness();
  }

  private event(taskId: string, type: string, data: unknown) {
    this.db.prepare('INSERT INTO event(taskId,type,data) VALUES(?,?,?)')
      .run(taskId, type, JSON.stringify(data));
    if (['run.finished', 'run.superseded', 'task.instruction_added', 'task.result_accepted'].includes(type)) {
      this.updateWorkflowReadiness(taskId);
    }
    const terminal = new Set(['run.finished', 'task.cancelled', 'run.lease_expired', 'run.device_revoked', 'approval.expired', 'run.inputs_changed', 'run.device_interrupted', 'run.deadline_exceeded', 'task.result_accepted', 'task.result_rejected', 'workflow.result_outdated']);
    if (!terminal.has(type) && type !== 'task.cancel_requested') return;
    const task = this.db.prepare('SELECT status FROM task WHERE id=?').get(taskId);
    const status = String(task?.status);
    const notices: Record<string, string> = {
      succeeded: 'completed', failed: 'failed', cancelled: 'was cancelled', waiting_user: 'needs attention', waiting_review: 'needs result review',
    };
    const notice = notices[status];
    if (!notice) return;
    const routes = this.db.prepare('SELECT channel,chat,thread FROM channel_thread WHERE task_id=?').all(taskId);
    const now = Date.now();
    this.queuePush(taskId, 'task_update', now);
    const text = `Blazar task ${notice}. Open Blazar to view details. Task: ${taskId}`;
    for (const route of routes) {
      this.db.prepare('INSERT INTO channel_outbox VALUES(?,?,?,?,?,?,?,0)')
        .run(randomUUID(), String(route.channel), String(route.chat), String(route.thread), text, now, now);
    }
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

  pruneProgressEvents(before: number) {
    return this.transaction(() => {
      const latestRemoved = this.db.prepare('SELECT MAX(seq) AS last FROM progress_event_time WHERE created_at<?').get(before);
      if (latestRemoved?.last == null) return 0;
      const { changes } = this.db.prepare('DELETE FROM event WHERE seq IN (SELECT seq FROM progress_event_time WHERE created_at<?)')
        .run(before);
      this.db.prepare(`INSERT INTO event_retention VALUES(1,?) ON CONFLICT(id)
        DO UPDATE SET replay_floor=MAX(replay_floor,excluded.replay_floor)`).run(latestRemoved.last);
      return Number(changes);
    });
  }

  snapshot(owner: string) {
    return this.transaction(() => {
      const tasks = this.db.prepare('SELECT * FROM task WHERE owner=? ORDER BY rowid DESC').all(owner) as unknown as Task[];
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
      const progress = this.db.prepare(`SELECT r.taskId,r.id AS runId,p.message
        FROM run r JOIN task t ON t.id=r.taskId JOIN run_progress p ON p.run_id=r.id
        WHERE t.owner=? AND t.status='running' AND r.version=t.version
        AND p.device_seq=(SELECT MAX(device_seq) FROM run_progress WHERE run_id=r.id)`).all(owner);
      const workflowSteps = this.db.prepare(`SELECT s.workflow_id AS workflowId,s.step_key AS stepKey,
        s.task_id AS taskId,d.predecessor AS predecessorId FROM workflow_step s
        JOIN workflow w ON w.id=s.workflow_id LEFT JOIN workflow_dependency d ON d.task_id=s.task_id
        WHERE w.owner=? ORDER BY s.rowid`).all(owner);
      const criteria = this.db.prepare(`SELECT c.task_id AS taskId,c.criterion FROM task_criterion c
        JOIN task t ON t.id=c.task_id WHERE t.owner=? ORDER BY c.task_id,c.position`).all(owner);
      return { tasks, artifacts, approvals, progress, workflowSteps, criteria, cursor };
    });
  }

  artifact(owner: string, id: string, now = Date.now()) {
    return this.db.prepare(`SELECT a.taskId,a.name,a.sha256,a.content,v.task_version AS version,
      CASE WHEN i.artifact_id IS NOT NULL THEN 'image/png' END AS mime FROM artifact a
      JOIN task t ON t.id=a.taskId LEFT JOIN artifact_image i ON i.artifact_id=a.id
      LEFT JOIN artifact_version v ON v.artifact_id=a.id
      WHERE t.owner=? AND a.id=? AND (i.expires IS NULL OR i.expires>?)`).get(owner, id, now) as
      { taskId: string; name: string; sha256: string; content: Uint8Array; mime: 'image/png' | null; version: number | null } | undefined;
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

  events(owner: string, after: number, through = Number.MAX_SAFE_INTEGER): TaskEvent[] {
    return this.db.prepare(`SELECT e.* FROM event e JOIN task t ON e.taskId=t.id
      WHERE t.owner=? AND e.seq>? AND e.seq<=? ORDER BY e.seq LIMIT 100`).all(owner, after, through) as unknown as TaskEvent[];
  }

  findRouterTasks(owner: string, workspace: string, query: string, includeAppEvidence = false) {
    return this.db.prepare(`SELECT id,substr(goal,1,320) AS goal,status,version FROM task WHERE owner=? AND workspace=?
      AND (?='' OR id=? OR instr(lower(goal),lower(?))>0)
      AND (? OR NOT EXISTS(SELECT 1 FROM task_app_evidence e WHERE e.task_id=task.id))
      ORDER BY rowid DESC LIMIT 8`).all(owner, workspace, query, query, query, Number(includeAppEvidence))
      .map(row => ({ id: String(row.id), goal: String(row.goal).toWellFormed(), status: String(row.status), version: Number(row.version) }));
  }

  recentConversation(owner: string, workspace: string): ConversationTurn[] {
    return this.db.prepare(`SELECT json_extract(request,'$[1]') AS text,decision FROM routing_decision
      WHERE owner=? AND json_extract(request,'$[0]')=? AND json_array_length(request)=2
      AND NOT (
        json_extract(request,'$[1]') IN ('/status','/状态')
        OR json_extract(request,'$[1]') GLOB '/status *' OR json_extract(request,'$[1]') GLOB '/状态 *'
      ) ORDER BY rowid DESC LIMIT 6`)
      .all(owner, workspace).reverse().map(row => {
        const decision = JSON.parse(String(row.decision)) as Decision;
        if (decision.kind === 'propose_workflow') {
          decision.text = decision.text.slice(0, 2_000);
          decision.steps = decision.steps.map(step => ({ ...step, goal: step.goal.slice(0, 200) }));
        } else if (decision.kind === 'append_task') {
          decision.text = decision.text.slice(0, 2_000);
          decision.instruction = decision.instruction.slice(0, 2_000);
        } else if (decision.kind !== 'create_task') decision.text = decision.text.slice(0, 2_000);
        else if (decision.goal) decision.goal = decision.goal.slice(0, 2_000);
        return { text: String(row.text).slice(0, 2_000), decision };
      });
  }

  routingDecision(owner: string, key: string, request: RouteRequest, decision?: Decision): Decision | undefined {
    const fingerprint = JSON.stringify(request.usePersonalMemory
      ? [request.workspace, request.text, true] : [request.workspace, request.text]);
    if (decision) {
      this.db.prepare('INSERT OR IGNORE INTO routing_decision VALUES(?,?,?,?)')
        .run(owner, key, fingerprint, JSON.stringify(decision));
    }
    const row = this.db.prepare('SELECT request,decision FROM routing_decision WHERE owner=? AND key=?').get(owner, key);
    if (!row) return undefined;
    if (row.request !== fingerprint) throw new IdempotencyConflict();
    return JSON.parse(String(row.decision)) as Decision;
  }

  channelCursor(channel: string): string {
    const row = this.db.prepare('SELECT value FROM channel_cursor WHERE channel=?').get(channel);
    return row ? String(row.value) : '';
  }

  saveChannelCursor(channel: string, value: string) {
    this.db.prepare(`INSERT INTO channel_cursor VALUES(?,?)
      ON CONFLICT(channel) DO UPDATE SET value=excluded.value`).run(channel, value);
  }

  leaseChannelNotice(channel: string, now: number, chats?: readonly string[], atMostOnce = false) {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT id,chat,message_id AS messageId,text FROM channel_outbox
        WHERE channel=? AND delivered=0 AND retry<=? AND created>?
        AND (? IS NULL OR chat IN (SELECT value FROM json_each(?))) ORDER BY created,rowid LIMIT 1`)
        .get(channel, now, now - 10 * 60_000, chats ? JSON.stringify(chats) : null, chats ? JSON.stringify(chats) : null) as
        { id: string; chat: string; messageId: string; text: string } | undefined;
      if (row) {
        this.db.prepare('UPDATE channel_outbox SET retry=?,delivered=? WHERE id=?')
          .run(now + 30_000, atMostOnce ? -2 : 0, row.id);
      }
      return row;
    });
  }

  leaseWeixinNotice(owner: string, channel: string, now: number, senders: readonly string[]) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM weixin_reply_context WHERE expires<=?').run(now);
      const row = this.db.prepare(`SELECT o.id,o.chat,o.text,c.token AS context FROM channel_outbox o
        JOIN weixin_reply_context c ON c.channel=o.channel AND c.chat=o.chat
        WHERE c.owner=? AND o.channel=? AND o.delivered=0 AND o.retry<=? AND o.created>?
        AND o.chat IN (SELECT value FROM json_each(?))
        AND EXISTS (SELECT 1 FROM channel_thread t WHERE t.owner=c.owner AND t.channel=o.channel
          AND t.chat=o.chat AND t.thread=o.message_id)
        ORDER BY o.created,o.rowid LIMIT 1`).get(owner, channel, now, now - 10 * 60_000, JSON.stringify(senders)) as
        { id: string; chat: string; text: string; context: string } | undefined;
      if (row) this.db.prepare('UPDATE channel_outbox SET delivered=-2 WHERE id=?').run(row.id);
      return row;
    });
  }

  leasePassiveNotice(channel: string, now: number, chats: readonly string[]) {
    return this.transaction(() => {
      const candidate = this.db.prepare(`SELECT o.id,o.chat,o.message_id AS messageId,o.text,w.expires,
        1 + (SELECT COUNT(*) FROM channel_outbox sent
          WHERE sent.channel=o.channel AND sent.chat=o.chat AND sent.message_id=o.message_id
          AND sent.delivered IN (-2,1)) AS seq
        FROM channel_outbox o JOIN channel_reply_window w ON w.channel=o.channel
          AND w.chat=o.chat AND w.message_id=o.message_id
        WHERE o.channel=? AND o.delivered=0 AND w.expires>?
          AND o.chat IN (SELECT value FROM json_each(?)) AND seq<=5 ORDER BY o.created,o.rowid LIMIT 1`)
        .get(channel, now, JSON.stringify(chats)) as
        { id: string; chat: string; messageId: string; text: string; expires: number; seq: number } | undefined;
      if (candidate) this.db.prepare('UPDATE channel_outbox SET delivered=-2 WHERE id=?').run(candidate.id);
      return candidate;
    });
  }

  finishChannelNotice(id: string, delivered: boolean) {
    this.db.prepare('UPDATE channel_outbox SET delivered=? WHERE id=?').run(delivered ? 1 : -1, id);
  }

  createTaskLink(owner: string, taskId: string, now: number) {
    return this.transaction(() => {
      if (!this.get(owner, taskId)) return undefined;
      this.db.prepare('DELETE FROM task_link_code WHERE expires<=? OR task_id=?').run(now, taskId);
      const code = randomBytes(24).toString('base64url');
      const hash = createHash('sha256').update(code).digest('hex');
      const expires = now + 5 * 60_000;
      this.db.prepare('INSERT INTO task_link_code VALUES(?,?,?)').run(hash, taskId, expires);
      return { code, expires };
    });
  }

  taskChannels(owner: string, taskId: string, now = Date.now()) {
    return this.db.prepare(`SELECT c.channel,c.chat,c.thread,o.created,CASE
      WHEN o.id IS NULL THEN NULL
      WHEN o.delivered=1 THEN 'sent'
      WHEN o.delivered=-1 THEN 'failed'
      WHEN o.delivered=-2 THEN 'unknown'
      WHEN COALESCE(w.expires,o.created+600000)<=? THEN 'expired'
      ELSE 'pending' END AS delivery
      FROM channel_thread c JOIN task t ON c.task_id=t.id
      LEFT JOIN channel_outbox o ON o.rowid=(
        SELECT rowid FROM channel_outbox WHERE channel=c.channel AND chat=c.chat AND message_id=c.thread
        ORDER BY created DESC,rowid DESC LIMIT 1
      )
      LEFT JOIN channel_reply_window w ON w.channel=c.channel AND w.chat=c.chat AND w.message_id=c.thread
      WHERE t.owner=? AND c.task_id=? ORDER BY c.rowid`)
      .all(now, owner, taskId).map(row => {
        const channel = String(row.channel);
        const chat = String(row.chat);
        const thread = String(row.thread);
        const id = createHash('sha256').update(JSON.stringify([channel, chat, thread])).digest('hex');
        return { id, channel, chat, thread, delivery: row.delivery };
      });
  }

  unlinkTaskChannel(owner: string, taskId: string, linkId: string) {
    return this.transaction(() => {
      const link = this.taskChannels(owner, taskId).find(item => item.id === linkId);
      if (!link) return false;
      this.db.prepare('DELETE FROM channel_thread WHERE owner=? AND task_id=? AND channel=? AND chat=? AND thread=?')
        .run(owner, taskId, link.channel, link.chat, link.thread);
      this.db.prepare('DELETE FROM channel_outbox WHERE channel=? AND chat=? AND message_id=? AND delivered=0')
        .run(link.channel, link.chat, link.thread);
      this.db.prepare(`DELETE FROM channel_outbox WHERE delivered=0 AND id IN (
        SELECT notice FROM channel_notice_binding WHERE owner=? AND channel=? AND chat=? AND thread=?
      )`).run(owner, link.channel, link.chat, link.thread);
      this.event(taskId, 'task.channel_unlinked', { channel: link.channel });
      return true;
    });
  }

  receiveChannelMessage(owner: string, channel: string, workspace: string,
                        message: { id: string; chat: string; thread: string; root: boolean; text: string; taskId?: string; replyExpires?: number }, weixinContext?: string) {
    if (message.text.startsWith('/observe ') || message.text.startsWith('/click ')) return;
    return this.transaction(() => {
      const existing = this.db.prepare('INSERT OR IGNORE INTO channel_message VALUES(?,?,?)')
        .run(owner, channel, message.id);
      if (!existing.changes) return;
      if (weixinContext) {
        this.db.prepare(`INSERT INTO weixin_reply_context VALUES(?,?,?,?,?) ON CONFLICT(owner,channel,chat)
          DO UPDATE SET token=excluded.token,expires=excluded.expires`)
          .run(owner, channel, message.chat, weixinContext, Date.now() + 10 * 60_000);
      }
      const key = [owner, channel, message.chat, message.thread] as const;
      const statusQuery = message.text === '/status' || message.text === '/状态';
      const pause = message.text === '/pause' || message.text === '/暂停';
      const resume = message.text === '/resume' || message.text === '/继续';
      if ((message.text === '/cancel' || statusQuery || pause || resume) && message.root) return;
      const linking = message.text === '/link' || message.text.startsWith('/link ');
      if (linking || message.root) {
        let taskId: string;
        if (linking) {
          const code = /^\/link ([A-Za-z0-9_-]{32})$/.exec(message.text)?.[1];
          if (!code || !message.root) return;
          const hash = createHash('sha256').update(code).digest('hex');
          const link = this.db.prepare(`DELETE FROM task_link_code WHERE code_hash=? AND expires>?
            AND EXISTS(SELECT 1 FROM task t WHERE t.id=task_link_code.task_id AND t.owner=? AND t.workspace=?)
            RETURNING task_id`).get(hash, Date.now(), owner, workspace);
          if (!link) return;
          taskId = String(link.task_id);
        } else {
          taskId = randomUUID();
          this.db.prepare('INSERT INTO task(id,owner,workspace,goal) VALUES(?,?,?,?)')
            .run(taskId, owner, workspace, message.text);
        }
        this.db.prepare('INSERT INTO channel_thread VALUES(?,?,?,?,?)').run(...key, taskId);
        if (message.replyExpires !== undefined) {
          this.db.prepare('INSERT INTO channel_reply_window VALUES(?,?,?,?)')
            .run(channel, message.chat, message.id, message.replyExpires);
        }
        if (linking) this.event(taskId, 'task.channel_linked', { channel });
        else this.event(taskId, 'task.created', { goal: message.text, workspace, channel });
        return;
      }
      const link = message.taskId
        ? this.db.prepare(`SELECT t.id,t.status,c.thread FROM channel_thread c JOIN task t ON t.id=c.task_id
            WHERE c.owner=? AND c.channel=? AND c.chat=? AND c.task_id=? AND t.workspace=?`)
          .get(owner, channel, message.chat, message.taskId, workspace)
        : this.db.prepare(`SELECT t.id,t.status,c.thread FROM channel_thread c JOIN task t ON t.id=c.task_id
            WHERE c.owner=? AND c.channel=? AND c.chat=? AND c.thread=? AND t.workspace=?`).get(...key, workspace);
      if (!link) return;
      const taskId = String(link.id);
      const canContinue = () => {
        const refs = this.appEvidence(taskId);
        return !refs || this.canUseChannelAppEvidence?.(owner, workspace, refs) === true;
      };
      if (statusQuery || pause || resume) {
        const previous = String(link.status);
        if (pause) this.pauseTask(taskId, previous, { channel });
        if (resume && canContinue()) this.requeueTask(taskId, previous, 'resume', { channel });
        const status = this.get(owner, taskId)!.status;
        const now = Date.now();
        const thread = String(link.thread);
        const replyId = message.replyExpires === undefined ? thread : message.id;
        if (message.replyExpires !== undefined) {
          if (message.replyExpires <= now) return;
          this.db.prepare('INSERT OR IGNORE INTO channel_reply_window VALUES(?,?,?,?)')
            .run(channel, message.chat, replyId, message.replyExpires);
        }
        const notice = randomUUID();
        const chinese = ['/状态', '/暂停', '/继续'].includes(message.text);
        const state = displayTaskStatus(status, chinese);
        const text = chinese ? `Blazar 任务${state}。任务 ID ${link.id}` : `Blazar task status: ${state}. Task: ${link.id}`;
        this.db.prepare('INSERT INTO channel_outbox VALUES(?,?,?,?,?,?,?,0)')
          .run(notice, channel, message.chat, replyId, text, now, now);
        if (replyId !== thread) {
          this.db.prepare('INSERT INTO channel_notice_binding VALUES(?,?,?,?,?)')
            .run(notice, owner, channel, message.chat, thread);
        }
        return;
      }
      if (message.text === '/cancel') {
        this.cancelTask(String(link.id), String(link.status), { channel });
        return;
      }
      if (['cancelled', 'cancelling', 'paused', 'pausing'].includes(String(link.status)) || !canContinue()) return;
      this.appendInstruction(taskId, message.text, String(link.status), { channel });
    });
  }

  private pauseTask(taskId: string, previousStatus: string, metadata: Record<string, string> = {}) {
    if (!['queued', 'running', 'waiting_user', 'waiting_dependency', 'waiting_device'].includes(previousStatus)) return false;
    const live = this.db.prepare('SELECT 1 FROM run WHERE taskId=?').get(taskId);
    const status = live ? 'pausing' : 'paused';
    this.db.prepare('UPDATE task SET status=?,version=version+1 WHERE id=?').run(status, taskId);
    this.event(taskId, 'task.pause_requested', { status, ...metadata });
    return true;
  }

  private requeueTask(taskId: string, previousStatus: string, action: 'resume' | 'retry', metadata: Record<string, string> = {}) {
    const allowed = action === 'resume' ? previousStatus === 'paused'
      : previousStatus === 'failed' || previousStatus === 'waiting_user';
    if (!allowed || this.db.prepare('SELECT 1 FROM run WHERE taskId=?').get(taskId)) return false;
    this.db.prepare("UPDATE task SET status='queued',version=version+1,result=NULL WHERE id=?").run(taskId);
    this.event(taskId, action === 'resume' ? 'task.resumed' : 'task.retry_requested', {
      status: 'queued', previousStatus, ...metadata,
    });
    this.updateWorkflowReadiness(taskId);
    return true;
  }

  private cancelTask(taskId: string, priorStatus: string, metadata: Record<string, string> = {}) {
    if (!['queued', 'running', 'waiting_user', 'waiting_dependency', 'waiting_device', 'pausing', 'paused', 'waiting_review'].includes(priorStatus)) {
      return false;
    }
    const liveRun = this.db.prepare('SELECT 1 FROM run WHERE taskId=?').get(taskId);
    const status = liveRun ? 'cancelling' : 'cancelled';
    this.db.prepare('UPDATE task SET status=?,version=version+1 WHERE id=?').run(status, taskId);
    this.event(taskId, 'task.cancel_requested', { status, ...metadata });
    return true;
  }

  private appendInstruction(taskId: string, text: string, previousStatus: string, metadata: Record<string, string> = {}) {
    const run = this.db.prepare('SELECT id FROM run WHERE taskId=?').get(taskId);
    const updated = this.db.prepare('UPDATE task SET status=?,version=version+1,result=NULL WHERE id=? RETURNING version')
      .get(run ? 'running' : 'queued', taskId)!;
    this.event(taskId, 'task.instruction_added', { text, ...metadata, version: updated.version });
    if (previousStatus === 'succeeded') this.invalidateCompletedDescendants(taskId);
  }

  create(owner: string, source: string, key: string, workspace: string, goal: string, desktopDevice?: string,
         memoryInputs?: TaskMemoryInput[], appEvidence?: AppEvidence): Task {
    return this.transaction(() => {
      const fingerprint = JSON.stringify(appEvidence
        ? [workspace, goal, { query: appEvidence.query, sources: appEvidence.sources, usePersonalMemory: Boolean(memoryInputs) }]
        : memoryInputs
        ? [workspace, goal, desktopDevice ?? null, { usePersonalMemory: true }]
        : desktopDevice ? [workspace, goal, desktopDevice] : [workspace, goal]);
      const receipt = this.db.prepare('SELECT fingerprint, taskId FROM receipt WHERE owner=? AND source=? AND key=?')
        .get(owner, source, key);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new IdempotencyConflict();
        return this.get(owner, String(receipt.taskId))!;
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO task(id,owner,workspace,goal) VALUES(?,?,?,?)').run(id, owner, workspace, goal);
      this.db.prepare('INSERT INTO receipt VALUES(?,?,?,?,?)').run(owner, source, key, fingerprint, id);
      if (desktopDevice) this.db.prepare('INSERT INTO task_desktop_device VALUES(?,?)').run(id, desktopDevice);
      for (const [position, input] of (memoryInputs ?? []).entries()) {
        this.db.prepare('INSERT INTO task_memory_input VALUES(?,?,?,?,?)')
          .run(id, position, input.id, input.version, input.body);
      }
      if (appEvidence) {
        if (!appEvidence.refs.length) throw new Error('No authorized application evidence was found');
        this.db.prepare('INSERT INTO task_app_evidence VALUES(?,?)').run(id, JSON.stringify(appEvidence.refs));
      }
      this.event(id, 'task.created', { goal, workspace, ...(desktopDevice && { desktopDevice }),
        ...(memoryInputs?.length && { memoryInputs: memoryInputs.map(({ id, version }) => ({ id, version })) }),
        ...(appEvidence && { appEvidence: appEvidence.refs }),
      });
      return this.get(owner, id)!;
    });
  }

  appEvidence(taskId: string) {
    const row = this.db.prepare('SELECT refs FROM task_app_evidence WHERE task_id=?').get(taskId);
    return row ? JSON.parse(String(row.refs)) as { id: string; version: number }[] : undefined;
  }

  appEvidenceTasks(owner: string) {
    return this.db.prepare(`SELECT e.task_id FROM task_app_evidence e JOIN task t ON t.id=e.task_id
      WHERE t.owner=?`).all(owner).map(row => String(row.task_id));
  }

  runTaskId(runId: string, device: string) {
    return this.db.prepare('SELECT taskId FROM run WHERE id=? AND device=?').get(runId, device)?.taskId as string | undefined;
  }

  pendingAppEvidenceTasks() {
    return this.db.prepare(`SELECT t.id,t.owner,t.workspace,e.refs,r.id AS run_id,r.device FROM task_app_evidence e
      JOIN task t ON t.id=e.task_id LEFT JOIN run r ON r.taskId=t.id
      WHERE (r.id IS NULL AND t.status IN ('queued','waiting_device','waiting_dependency','waiting_review'))
        OR (r.id IS NOT NULL AND t.status IN ('running','waiting_user')
          AND NOT EXISTS(SELECT 1 FROM run_evidence_stop s WHERE s.run_id=r.id))`)
      .all().map(row => ({
        id: String(row.id), owner: String(row.owner), workspace: String(row.workspace), refs: String(row.refs),
        run: row.run_id === null ? undefined : { id: String(row.run_id), device: String(row.device) },
      }));
  }

  suspendTaskForAppEvidence(taskId: string) {
    return this.transaction(() => {
      const updated = this.db.prepare(`UPDATE task SET status='waiting_user',result=NULL WHERE id=?
        AND status IN ('queued','waiting_device','waiting_dependency','waiting_review')
        AND NOT EXISTS(SELECT 1 FROM run WHERE taskId=task.id)`).run(taskId);
      if (updated.changes) this.event(taskId, 'task.memory_access_changed', { status: 'waiting_user' });
    });
  }

  requestRunEvidenceStop(runId: string, device: string) {
    return this.transaction(() => {
      const taskId = this.runTaskId(runId, device);
      if (!taskId) return false;
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO run_evidence_stop
        SELECT r.id FROM run r JOIN task t ON t.id=r.taskId WHERE r.id=? AND t.status IN ('running','waiting_user')`).run(runId);
      if (inserted.changes) {
        this.db.prepare("UPDATE task SET status='waiting_user',result=NULL WHERE id=?").run(taskId);
        this.event(taskId, 'run.memory_access_changed', { runId, status: 'waiting_user' });
      }
      return Boolean(inserted.changes);
    });
  }

  runEvidenceStopping(runId: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM run_evidence_stop WHERE run_id=?').get(runId));
  }

  rejectRunEvidence(runId: string, device: string) {
    this.transaction(() => {
      const taskId = this.runTaskId(runId, device);
      if (!taskId) return;
      const status = this.db.prepare('SELECT status FROM task WHERE id=?').get(taskId)?.status;
      if (status === 'pausing' || status === 'cancelling') {
        this.finishStoppedRun(runId, taskId, status === 'pausing');
      } else {
        this.finishRejectedEvidence(runId, taskId);
      }
    });
  }

  private finishRejectedEvidence(runId: string, taskId: string) {
    const wasStopping = this.runEvidenceStopping(runId);
    this.db.prepare("UPDATE task SET status='waiting_user',result=NULL WHERE id=?").run(taskId);
    this.db.prepare('DELETE FROM run WHERE id=?').run(runId);
    if (!wasStopping) this.event(taskId, 'run.memory_access_changed', { runId, status: 'waiting_user' });
  }

  createWorkflow(owner: string, key: string, workspace: string, steps: WorkflowStep[], appEvidence?: AppEvidence) {
    const ordered = orderWorkflow(steps);

    return this.transaction(() => {
      const fingerprint = JSON.stringify(appEvidence
        ? [workspace, steps, { query: appEvidence.query, sources: appEvidence.sources }]
        : [workspace, steps]);
      const existing = this.db.prepare('SELECT id,fingerprint FROM workflow WHERE owner=? AND request_key=?')
        .get(owner, key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new IdempotencyConflict();
        return { id: String(existing.id), steps: this.workflowSteps(String(existing.id)) };
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO workflow VALUES(?,?,?,?)').run(id, owner, key, fingerprint);
      const tasks = new Map<string, string>();
      for (const step of ordered) {
        const name = step.key;
        const taskId = randomUUID();
        tasks.set(name, taskId);
        const status = step.needs.length ? 'waiting_dependency' : 'queued';
        this.db.prepare('INSERT INTO task(id,owner,workspace,goal,status) VALUES(?,?,?,?,?)')
          .run(taskId, owner, workspace, step.goal, status);
        this.db.prepare('INSERT INTO workflow_step VALUES(?,?,?)').run(id, name, taskId);
        if (step.requireReview) this.db.prepare('INSERT INTO task_review VALUES(?)').run(taskId);
        for (const [position, criterion] of (step.acceptanceCriteria ?? []).entries()) {
          this.db.prepare('INSERT INTO task_criterion VALUES(?,?,?)').run(taskId, position, criterion);
        }
        const predecessors = [...new Set(step.needs)].map(dependency => tasks.get(dependency)!);
        for (const predecessor of predecessors) {
          this.db.prepare('INSERT INTO workflow_dependency VALUES(?,?)').run(taskId, predecessor);
        }
        if (appEvidence) {
          this.db.prepare('INSERT INTO task_app_evidence VALUES(?,?)').run(taskId, JSON.stringify(appEvidence.refs));
        }
        this.event(taskId, 'task.created', { goal: step.goal, workspace, workflowId: id, stepKey: name, predecessors, status,
          ...(appEvidence && { appEvidence: appEvidence.refs }),
        });
      }
      return { id, steps: this.workflowSteps(id) };
    });
  }

  private workflowSteps(id: string) {
    return this.db.prepare('SELECT step_key AS key,task_id AS taskId FROM workflow_step WHERE workflow_id=? ORDER BY rowid')
      .all(id);
  }

  command(owner: string, taskId: string, version: number, command: { action: 'cancel' | 'pause' | 'resume' | 'retry' | 'accept_result' | 'reject_result' } | { action: 'append'; text: string } | { action: 'approve' | 'deny'; approvalId: string }, key?: string) {
    return this.transaction(() => {
      const fingerprint = JSON.stringify([taskId, version, command]);
      if (key) {
        const receipt = this.db.prepare('SELECT fingerprint,response FROM command_receipt WHERE owner=? AND key=?')
          .get(owner, key);
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) throw new IdempotencyConflict();
          return JSON.parse(String(receipt.response)) as Task;
        }
      }
      const task = this.get(owner, taskId);
      if (!task || task.version !== version) return undefined;
      const liveRun = this.db.prepare('SELECT id FROM run WHERE taskId=?').get(taskId);
      if (command.action === 'approve' || command.action === 'deny') {
        if (task.status !== 'waiting_user') return undefined;
        const now = Date.now();
        const decision = command.action === 'approve' ? 'approved' : 'denied';
        const changed = this.db.prepare(`UPDATE approval SET decision=? WHERE id=? AND taskId=?
          AND version=? AND decision IS NULL AND expires>? AND EXISTS(
            SELECT 1 FROM run WHERE id=approval.runId AND expires>?
            AND NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=run.id)
            AND NOT EXISTS(SELECT 1 FROM run_evidence_stop s WHERE s.run_id=run.id))`)
          .run(decision, command.approvalId, taskId, version, now, now);
        if (!changed.changes) return undefined;
        this.db.prepare("UPDATE task SET status='running' WHERE id=?").run(taskId);
        this.event(taskId, 'approval.decided', { approvalId: command.approvalId, decision });
      } else if (command.action === 'accept_result' || command.action === 'reject_result') {
        if (task.status !== 'waiting_review' || liveRun) return undefined;
        const accepted = command.action === 'accept_result';
        if (accepted && this.db.prepare(`SELECT 1 FROM review_input i JOIN task p ON p.id=i.predecessor
          WHERE i.task_id=? AND (p.status!='succeeded' OR p.version<>i.version)`).get(taskId)) return undefined;
        const status = accepted ? 'succeeded' : 'failed';
        this.db.prepare('UPDATE task SET status=?,version=version+1 WHERE id=?').run(status, taskId);
        if (accepted) {
          this.db.prepare(`UPDATE artifact_version SET task_version=? WHERE task_version=?
            AND artifact_id IN (SELECT id FROM artifact WHERE taskId=?)`).run(version + 1, version, taskId);
        }
        this.db.prepare('DELETE FROM review_input WHERE task_id=?').run(taskId);
        this.event(taskId, accepted ? 'task.result_accepted' : 'task.result_rejected', { status });
      } else if (command.action === 'pause') {
        if (!this.pauseTask(taskId, task.status)) return undefined;
      } else if (command.action === 'resume' || command.action === 'retry') {
        if (!this.requeueTask(taskId, task.status, command.action)) return undefined;
      } else if (command.action === 'cancel') {
        if (!this.cancelTask(taskId, task.status)) return undefined;
      } else if (command.action === 'append') {
        if (['cancelling', 'cancelled', 'pausing', 'paused'].includes(task.status)) return undefined;
        this.appendInstruction(taskId, command.text, task.status);
      }
      const updated = this.get(owner, taskId)!;
      if (key) {
        this.db.prepare('INSERT INTO command_receipt VALUES(?,?,?,?)')
          .run(owner, key, fingerprint, JSON.stringify(updated));
      }
      return updated;
    });
  }

  createPairing(owner: string, now: number) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM mobile_pairing WHERE expires<=?').run(now);
      const code = randomBytes(24).toString('base64url');
      const hash = createHash('sha256').update(code).digest('hex');
      const expires = now + 5 * 60_000;
      this.db.prepare('INSERT INTO mobile_pairing VALUES(?,?,?)').run(hash, owner, expires);
      return { code, expires };
    });
  }

  redeemPairing(code: string, name: string, now: number) {
    return this.transaction(() => {
      const hash = createHash('sha256').update(code).digest('hex');
      const pairing = this.db.prepare('DELETE FROM mobile_pairing WHERE code_hash=? AND expires>? RETURNING owner')
        .get(hash, now);
      if (!pairing) return undefined;
      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      this.db.prepare('INSERT INTO mobile_client VALUES(?,?,?,?)').run(id, pairing.owner!, name, tokenHash);
      return { id, token };
    });
  }

  requestMobilePairing(code: string, name: string, token: string, now: number) {
    return this.transaction(() => {
      const hash = createHash('sha256').update(code).digest('hex');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const replay = this.db.prepare(`SELECT p.id,p.expires FROM mobile_pairing_receipt r
        JOIN mobile_pairing_request p ON p.id=r.request_id
        WHERE r.code_hash=? AND p.token_hash=? AND p.name=? AND p.expires>?`).get(hash, tokenHash, name, now);
      if (replay) return { id: String(replay.id), expires: Number(replay.expires) };
      if (this.db.prepare('SELECT 1 FROM mobile_client WHERE token_hash=?').get(tokenHash)) return undefined;
      const prior = this.db.prepare('SELECT 1 FROM mobile_pairing_request WHERE token_hash=? AND expires>?').get(tokenHash, now);
      if (prior) return undefined;
      const pairing = this.db.prepare('DELETE FROM mobile_pairing WHERE code_hash=? AND expires>? RETURNING owner,expires')
        .get(hash, now);
      if (!pairing) return undefined;
      this.db.prepare('DELETE FROM mobile_pairing_request WHERE expires<=?').run(now);
      const id = randomUUID();
      this.db.prepare("INSERT INTO mobile_pairing_request VALUES(?,?,?,?,?,'pending')")
        .run(id, pairing.owner!, name, tokenHash, pairing.expires!);
      this.db.prepare('INSERT INTO mobile_pairing_receipt VALUES(?,?)').run(hash, id);
      return { id, expires: Number(pairing.expires) };
    });
  }

  pendingMobilePairings(owner: string, now: number) {
    return this.db.prepare("SELECT id,name,expires FROM mobile_pairing_request WHERE owner=? AND expires>? AND state='pending'")
      .all(owner, now);
  }

  decideMobilePairing(owner: string, id: string, approve: boolean, now: number) {
    return this.transaction(() => {
      const row = this.db.prepare(`UPDATE mobile_pairing_request SET state=?
        WHERE id=? AND owner=? AND expires>? AND state='pending' RETURNING name,token_hash`)
        .get(approve ? 'approved' : 'denied', id, owner, now);
      if (!row) return false;
      if (approve) this.db.prepare('INSERT INTO mobile_client VALUES(?,?,?,?)').run(id, owner, row.name!, row.token_hash!);
      return true;
    });
  }

  mobilePairingState(id: string, token: string, now: number) {
    const hash = createHash('sha256').update(token).digest('hex');
    const row = this.db.prepare('SELECT state FROM mobile_pairing_request WHERE id=? AND token_hash=? AND expires>?')
      .get(id, hash, now);
    return row?.state === 'approved' && !this.mobileIdentity(token) ? 'denied' : row?.state;
  }

  mobileIdentity(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const hash = createHash('sha256').update(token).digest('hex');
    return this.db.prepare('SELECT id,owner FROM mobile_client WHERE token_hash=?').get(hash) as
      { id: string; owner: string } | undefined;
  }

  mobileOwner(token: string) {
    return this.mobileIdentity(token)?.owner;
  }

  resultGrants(owner: string, taskId: string) {
    return this.db.prepare(`SELECT c.id,c.name,g.task_version AS version FROM mobile_client c
      LEFT JOIN mobile_result_grant g ON g.client_id=c.id AND g.task_id=?
      WHERE c.owner=? ORDER BY c.name,c.id`).all(taskId, owner);
  }

  shareTaskResult(owner: string, taskId: string, version: number, client: string, enabled: boolean) {
    if (!this.db.prepare('SELECT 1 FROM mobile_client WHERE id=? AND owner=?').get(client, owner)) return false;
    if (enabled) {
      this.db.prepare(`INSERT INTO mobile_result_grant VALUES(?,?,?)
        ON CONFLICT(client_id,task_id) DO UPDATE SET task_version=excluded.task_version`).run(client, taskId, version);
    } else {
      this.db.prepare('DELETE FROM mobile_result_grant WHERE client_id=? AND task_id=?').run(client, taskId);
    }
    return true;
  }

  canReadSharedResult(client: string, taskId: string, version: number) {
    return Boolean(this.db.prepare('SELECT 1 FROM mobile_result_grant WHERE client_id=? AND task_id=? AND task_version=?')
      .get(client, taskId, version));
  }

  registerPush(mobileToken: string, token: string | null) {
    return this.transaction(() => {
      const digest = createHash('sha256').update(mobileToken).digest('hex');
      const client = this.db.prepare('SELECT id FROM mobile_client WHERE token_hash=?').get(digest);
      if (!client) return false;
      const id = String(client.id);
      const previous = this.db.prepare('SELECT token FROM mobile_push WHERE client_id=?').get(id);
      if (previous?.token === token) return true;
      const assigned = token && this.db.prepare('SELECT client_id FROM mobile_push WHERE token=?').get(token);
      if (assigned && assigned.client_id !== id) return false;
      this.db.prepare('DELETE FROM mobile_push WHERE client_id=?').run(id);
      if (token) this.db.prepare('INSERT INTO mobile_push VALUES(?,?)').run(id, token);
      return true;
    });
  }

  private queuePush(taskId: string, kind: PushKind, now: number, approvalId?: string) {
    const clients = this.db.prepare(`SELECT p.client_id AS id FROM mobile_push p
      JOIN mobile_client c ON c.id=p.client_id JOIN task t ON t.owner=c.owner WHERE t.id=?`).all(taskId);
    for (const client of clients) {
      const id = randomUUID();
      this.db.prepare('INSERT INTO push_outbox(id,client_id,kind,expires,next_attempt) VALUES(?,?,?,?,?)')
        .run(id, client.id!, kind, now + 5 * 60_000, now);
      if (approvalId) this.db.prepare('INSERT INTO push_approval VALUES(?,?)').run(id, approvalId);
    }
  }

  leasePush(now: number) {
    return this.transaction(() => {
      this.db.prepare(`DELETE FROM push_outbox WHERE expires<=? OR (kind='approval' AND NOT EXISTS(
        SELECT 1 FROM push_approval p JOIN approval a ON a.id=p.approval_id
        JOIN run r ON r.id=a.runId JOIN task t ON t.id=a.taskId
        WHERE p.push_id=push_outbox.id AND a.decision IS NULL AND a.expires>? AND r.expires>?
        AND t.status='waiting_user' AND a.version=t.version AND r.version=t.version
        AND NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id)
      ))`).run(now, now, now);
      const row = this.db.prepare(`SELECT o.id,o.kind,o.attempts,p.token FROM push_outbox o
        JOIN mobile_push p ON p.client_id=o.client_id WHERE o.next_attempt<=?
        ORDER BY o.next_attempt,o.rowid LIMIT 1`).get(now) as
        { id: string; kind: PushKind; attempts: number; token: string } | undefined;
      if (row) this.db.prepare('UPDATE push_outbox SET next_attempt=?,attempts=attempts+1 WHERE id=?')
        .run(now + 30_000, row.id);
      return row;
    });
  }

  finishPush(id: string, result: PushResult, now: number) {
    if (result === 'retry') {
      this.db.prepare(`UPDATE push_outbox SET next_attempt=? + MIN(120000, 5000 * (1 << MIN(attempts,5)))
        WHERE id=?`).run(now, id);
    } else if (result === 'unregistered') {
      this.db.prepare('DELETE FROM mobile_push WHERE client_id=(SELECT client_id FROM push_outbox WHERE id=?)')
        .run(id);
    } else {
      this.db.prepare('DELETE FROM push_outbox WHERE id=?').run(id);
    }
  }

  mobileClients(owner: string) {
    return this.db.prepare('SELECT id,name FROM mobile_client WHERE owner=? ORDER BY rowid DESC').all(owner);
  }

  revokeMobile(owner: string, id: string) {
    return this.db.prepare('DELETE FROM mobile_client WHERE owner=? AND id=?').run(owner, id).changes === 1;
  }

  registerDevice(owner: string, name: string, workspace: string) {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    this.db.prepare('INSERT INTO device(id,owner,workspace,name,token_hash) VALUES(?,?,?,?,?)')
      .run(id, owner, workspace, name, hash);
    return { id, name, workspace, token };
  }

  devices(owner: string, now = Date.now()) {
    return this.db.prepare(`SELECT d.id,d.name,d.workspace,d.revoked,p.last_seen AS lastSeen,
      p.capability,p.platform,w.label AS workerLabel,w.protocol AS workerProtocol,
      i.run_id AS interruptedRunId,(pause.device_id IS NOT NULL) AS paused,CASE WHEN d.revoked=0 AND p.last_seen>=? THEN 1 ELSE 0 END AS online
      FROM device d LEFT JOIN device_presence p ON p.device_id=d.id
      LEFT JOIN device_interruption i ON i.device_id=d.id
      LEFT JOIN device_worker w ON w.device_id=d.id
      LEFT JOIN device_pause pause ON pause.device_id=d.id
      WHERE d.owner=? ORDER BY d.rowid DESC`).all(now - 45_000, owner);
  }

  metrics(owner: string, now: number) {
    const tasks = this.db.prepare('SELECT status,COUNT(*) AS count FROM task WHERE owner=? GROUP BY status').all(owner);
    const devices = this.devices(owner, now);
    return {
      tasks: Object.fromEntries(tasks.map(row => [row.status, row.count])),
      devices: {
        active: devices.filter(device => !device.revoked).length,
        online: devices.filter(device => device.online).length,
        interrupted: devices.filter(device => !device.revoked && device.interruptedRunId).length,
      },
    };
  }

  recordDesktopApps(device: string, aliases?: string[], permissions?: Record<string, string>, controls?: DesktopAppControls[]) {
    if (controls) {
      this.db.prepare(`INSERT INTO device_desktop_controls VALUES(?,?) ON CONFLICT(device_id)
        DO UPDATE SET controls=excluded.controls WHERE controls<>excluded.controls`).run(device, JSON.stringify(controls));
    } else {
      this.db.prepare('DELETE FROM device_desktop_controls WHERE device_id=?').run(device);
    }
    if (permissions) {
      this.db.prepare(`INSERT INTO device_desktop_permissions VALUES(?,?) ON CONFLICT(device_id)
        DO UPDATE SET states=excluded.states WHERE states<>excluded.states`).run(device, JSON.stringify(permissions));
    } else {
      this.db.prepare('DELETE FROM device_desktop_permissions WHERE device_id=?').run(device);
    }
    if (!aliases) {
      this.db.prepare('DELETE FROM device_desktop_apps WHERE device_id=?').run(device);
      return;
    }
    this.db.prepare(`INSERT INTO device_desktop_apps VALUES(?,?) ON CONFLICT(device_id)
      DO UPDATE SET aliases=excluded.aliases WHERE aliases<>excluded.aliases`).run(device, JSON.stringify(aliases));
  }

  desktopTargets(owner: string, now = Date.now()) {
    return this.db.prepare(`SELECT d.workspace,d.id AS deviceId,d.name AS deviceName,j.value AS alias,
      json_extract(xp.states,'$.accessibility') AS accessibility,
      json_extract(xp.states,'$.screen_recording') AS screenRecording,
      (SELECT value FROM json_each(c.controls) WHERE json_extract(value,'$.alias')=j.value) AS controls
      FROM device d
      JOIN device_presence p ON p.device_id=d.id JOIN device_desktop_apps a ON a.device_id=d.id
      LEFT JOIN device_desktop_permissions xp ON xp.device_id=d.id
      LEFT JOIN device_desktop_controls c ON c.device_id=d.id
      JOIN json_each(a.aliases) j WHERE d.owner=? AND d.revoked=0 AND p.last_seen>=?
      AND p.capability='computer.observe'
      AND NOT EXISTS(SELECT 1 FROM device_interruption i WHERE i.device_id=d.id)
      AND NOT EXISTS(SELECT 1 FROM device_pause x WHERE x.device_id=d.id)
      ORDER BY d.workspace,d.name,d.id,j.value LIMIT 250`).all(owner, now - 45_000)
      .map(({ controls, ...target }) => ({ ...target, controls: controls ? JSON.parse(String(controls)) as DesktopAppControls : null }));
  }

  ownsDesktopTarget(owner: string, workspace: string, id: string) {
    return Boolean(this.db.prepare(`SELECT 1 FROM device d JOIN device_desktop_apps a ON a.device_id=d.id
      WHERE d.owner=? AND d.workspace=? AND d.id=? AND d.revoked=0`).get(owner, workspace, id));
  }

  recordDeviceActivity(id: string, now: number, capability?: string, platform?: string) {
    this.db.prepare(`INSERT INTO device_presence VALUES(?,?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET last_seen=excluded.last_seen,
      capability=COALESCE(excluded.capability,device_presence.capability),
      platform=COALESCE(excluded.platform,device_presence.platform)
      WHERE excluded.last_seen>=device_presence.last_seen AND (
        excluded.last_seen-device_presence.last_seen>=10000 OR
        (excluded.capability IS NOT NULL AND excluded.capability IS NOT device_presence.capability) OR
        (excluded.platform IS NOT NULL AND excluded.platform IS NOT device_presence.platform)
      )`).run(id, now, capability ?? null, platform ?? null);
  }

  recordDeviceWorker(id: string, worker?: { label: string; protocol: string }) {
    if (!worker) {
      this.db.prepare('DELETE FROM device_worker WHERE device_id=?').run(id);
      return;
    }
    this.db.prepare(`INSERT INTO device_worker VALUES(?,?,?) ON CONFLICT(device_id)
      DO UPDATE SET label=excluded.label,protocol=excluded.protocol
      WHERE label<>excluded.label OR protocol<>excluded.protocol`).run(id, worker.label, worker.protocol);
  }

  reportInterruption(device: string, runId: string, now: number) {
    this.transaction(() => {
      this.recordDeviceActivity(device, now);
      this.db.prepare(`INSERT INTO device_interruption VALUES(?,?) ON CONFLICT(device_id)
        DO UPDATE SET run_id=excluded.run_id WHERE run_id<>excluded.run_id`).run(device, runId);
      const run = this.db.prepare('DELETE FROM run WHERE id=? AND device=? RETURNING taskId').get(runId, device);
      if (!run) return;
      const taskId = String(run.taskId);
      const task = this.db.prepare(`UPDATE task SET status=CASE WHEN status='cancelling'
        THEN 'cancelled' ELSE 'waiting_user' END,result=? WHERE id=? RETURNING status`)
        .get('The execution device restarted and requires local reconciliation.', taskId);
      this.event(taskId, 'run.device_interrupted', { runId, status: task?.status });
    });
  }

  clearInterruption(device: string) {
    this.db.prepare('DELETE FROM device_interruption WHERE device_id=?').run(device);
  }

  deviceForToken(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const hash = createHash('sha256').update(token).digest('hex');
    return this.db.prepare('SELECT id,owner,workspace FROM device WHERE token_hash=? AND revoked=0')
      .get(hash) as { id: string; owner: string; workspace: string } | undefined;
  }

  setDevicePaused(owner: string, id: string, paused: boolean) {
    return this.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM device WHERE owner=? AND id=? AND revoked=0').get(owner, id)) return false;
      if (paused) this.db.prepare('INSERT OR IGNORE INTO device_pause VALUES(?)').run(id);
      else this.db.prepare('DELETE FROM device_pause WHERE device_id=?').run(id);
      return true;
    });
  }

  revokeDevice(owner: string, id: string) {
    return this.transaction(() => {
      const revoked = this.db.prepare('UPDATE device SET revoked=1 WHERE owner=? AND id=? AND revoked=0')
        .run(owner, id);
      if (!revoked.changes) return false;
      const rows = this.db.prepare('SELECT id,taskId FROM run WHERE device=?').all(id);
      for (const row of rows) {
        const taskId = String(row.taskId);
        this.db.prepare(`UPDATE task SET status=CASE WHEN status='cancelling'
          THEN 'cancelled' ELSE 'waiting_user' END WHERE id=?`).run(taskId);
        this.db.prepare('DELETE FROM run WHERE id=?').run(String(row.id));
        this.event(taskId, 'run.device_revoked', { runId: row.id });
      }
      return true;
    });
  }

  claim(owner: string, workspace: string, device: string, now: number, leaseMs: number, goalPrefix = '', excludingPrefix = '', requestId?: string, worker?: WorkerConfiguration, desktopApps?: string[], allowWorkerMemory = false) {
    return this.transaction(() => {
      const identity = [owner, workspace, goalPrefix, excludingPrefix];
      const fingerprint = JSON.stringify(desktopApps ? [...identity, desktopApps] : worker ? [...identity, worker] : identity);
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
            AND NOT EXISTS(SELECT 1 FROM run_evidence_stop s WHERE s.run_id=r.id)
            AND (? OR (
              NOT EXISTS(SELECT 1 FROM task_app_evidence e WHERE e.task_id=t.id)
              AND NOT EXISTS(SELECT 1 FROM task_memory_input m WHERE m.task_id=t.id)))`)
            .get(assignment.run.id, device, now, Number(allowWorkerMemory));
          if (!current) return undefined;
          assignment.run.expires = Number(current.expires);
          return assignment as ReturnType<TaskStore['assignment']>;
        }
      }
      if (this.db.prepare('SELECT 1 FROM device_pause WHERE device_id=?').get(device)) return undefined;
      const task = this.db.prepare(`WITH eligible AS (
        SELECT task.rowid AS queue_order, task.*, COALESCE((
          SELECT json_extract(e.data,'$.channel') FROM event e
          WHERE e.taskId=task.id AND e.type='task.created' ORDER BY e.seq LIMIT 1
        ), '') AS origin_channel
        FROM task WHERE owner=? AND workspace=?
        AND status IN ('queued','waiting_device') AND (substr(goal,1,length(?))=? OR (?='/observe ' AND substr(goal,1,7)='/click '))
        AND (?='' OR (substr(goal,1,length(?))!=? AND substr(goal,1,9)!='/observe ' AND substr(goal,1,7)!='/click '))
        AND NOT EXISTS(SELECT 1 FROM task_desktop_device target WHERE target.task_id=task.id AND target.device_id<>?)
        AND (? OR (
          NOT EXISTS(SELECT 1 FROM task_app_evidence e WHERE e.task_id=task.id)
          AND NOT EXISTS(SELECT 1 FROM task_memory_input m WHERE m.task_id=task.id)))
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
        owner, workspace, goalPrefix, goalPrefix, goalPrefix, excludingPrefix, excludingPrefix, excludingPrefix, device, Number(allowWorkerMemory),
        desktopApps ? JSON.stringify(desktopApps) : null, desktopApps ? JSON.stringify(desktopApps) : null,
        goalPrefix, excludingPrefix) as unknown as (Task & { origin_channel: string }) | undefined;
      if (!task) {
        if (requestId) this.db.prepare('INSERT INTO device_claim VALUES(?,?,?,?,?)')
          .run(device, requestId, fingerprint, null, now + 10 * 60_000);
        return undefined;
      }
      const run: Run = { id: randomUUID(), taskId: task.id, version: task.version, device, expires: now + Math.min(leaseMs, runLimitMs) };
      this.db.prepare('INSERT INTO run VALUES(?,?,?,?,?)').run(run.id, task.id, device, run.version, run.expires);
      this.db.prepare('INSERT INTO run_deadline VALUES(?,?)').run(run.id, now + runLimitMs);
      this.db.prepare("UPDATE task SET status='running' WHERE id=?").run(task.id);
      const predecessors = this.predecessorInputs(task.id);
      if (predecessors.length) {
        this.db.prepare(`INSERT INTO run_dependency(run_id,predecessor,version)
          SELECT ?,p.id,p.version FROM workflow_dependency d JOIN task p ON p.id=d.predecessor
          WHERE d.task_id=?`).run(run.id, task.id);
      }
      this.event(task.id, 'run.started', {
        runId: run.id, ...(worker && { worker }), predecessors: predecessors.map(({ taskId, version, artifact }) => ({
          taskId, version, ...(artifact && { artifactId: artifact.id }),
        })),
      });
      this.db.prepare(`INSERT INTO channel_dispatch VALUES(?,?,?,?,?,?) ON CONFLICT
        (owner,workspace,goal_prefix,excluding_prefix,channel) DO UPDATE SET last_dispatch=excluded.last_dispatch`)
        .run(owner, workspace, goalPrefix, excludingPrefix, task.origin_channel, this.eventCursor());
      const assignment = this.assignment(owner, run, predecessors);
      if (requestId) this.db.prepare('INSERT INTO device_claim VALUES(?,?,?,?,?)')
        .run(device, requestId, fingerprint, JSON.stringify(assignment), now + 10 * 60_000);
      return assignment;
    });
  }

  private predecessorInputs(taskId: string): PredecessorInput[] {
    const rows = this.db.prepare(`SELECT p.id AS taskId,p.version,p.result,a.id AS artifactId,a.name,a.sha256,a.size,a.content
      FROM workflow_dependency d JOIN task p ON p.id=d.predecessor
      LEFT JOIN artifact a ON a.rowid=(
        SELECT a.rowid FROM artifact a JOIN artifact_version v ON v.artifact_id=a.id
        WHERE a.taskId=p.id AND v.task_version=p.version ORDER BY a.rowid DESC LIMIT 1
      )
      WHERE d.task_id=? ORDER BY p.rowid`).all(taskId);
    let budget = 16_000;
    return rows.map(row => {
      const input: PredecessorInput = {
        taskId: String(row.taskId), version: Number(row.version), result: row.result === null ? null : String(row.result),
      };
      if (!row.artifactId || !(row.content instanceof Uint8Array)) return input;
      const text = Buffer.from(row.content).toString('utf8');
      const excerpt = text.slice(0, Math.min(2000, budget)).toWellFormed();
      budget -= excerpt.length;
      input.artifact = {
        id: String(row.artifactId), name: String(row.name), sha256: String(row.sha256),
        excerpt, truncated: excerpt.length < text.length, size: Number(row.size),
      };
      return input;
    });
  }

  private assignment(owner: string, run: Run, predecessors: PredecessorInput[]) {
    const instructions = this.db.prepare(`SELECT data FROM event WHERE taskId=?
      AND type='task.instruction_added' ORDER BY seq`).all(run.taskId)
      .map(row => JSON.parse(String(row.data)).text as string);
    const acceptanceCriteria = this.db.prepare('SELECT criterion FROM task_criterion WHERE task_id=? ORDER BY position')
      .all(run.taskId).map(row => String(row.criterion));
    const memoryInputs = this.db.prepare('SELECT memory_id AS id,version,body FROM task_memory_input WHERE task_id=? ORDER BY position')
      .all(run.taskId) as unknown as TaskMemoryInput[];
    return { run, task: this.get(owner, run.taskId)!, instructions, predecessors, acceptanceCriteria,
      ...(memoryInputs.length && { memoryInputs }),
    };
  }

  runInputArtifact(runId: string, device: string, artifactId: string, now: number) {
    return this.db.prepare(`SELECT a.id,a.name,a.sha256,a.content FROM run r JOIN task t ON t.id=r.taskId
      JOIN run_dependency d ON d.run_id=r.id JOIN artifact a ON a.taskId=d.predecessor
      JOIN artifact_version v ON v.artifact_id=a.id AND v.task_version=d.version
      WHERE a.id=? AND r.id=? AND r.device=? AND r.expires>? AND t.status='running' AND r.version=t.version
      AND NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id)`)
      .get(artifactId, runId, device, now) as
      { id: string; name: string; sha256: string; content: Uint8Array } | undefined;
  }

  requestApproval(runId: string, device: string, summary: string, now: number) {
    return this.transaction(() => {
      const run = this.db.prepare(`SELECT r.taskId,r.version,t.status FROM run r JOIN task t ON r.taskId=t.id
        WHERE r.id=? AND r.device=? AND r.expires>? AND r.version=t.version
        AND NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id)`).get(runId, device, now);
      if (!run) return undefined;
      const existing = this.db.prepare(`SELECT id,summary,expires FROM approval
        WHERE runId=? AND version=? AND decision IS NULL AND expires>?`).get(runId, run.version!, now);
      if (existing) return existing.summary === summary ? existing : undefined;
      if (run.status !== 'running') return undefined;
      const id = randomUUID();
      const expires = now + 5 * 60_000;
      const taskId = String(run.taskId);
      this.db.prepare('INSERT INTO approval(id,runId,taskId,version,summary,expires) VALUES(?,?,?,?,?,?)')
        .run(id, runId, taskId, run.version!, summary, expires);
      this.db.prepare("UPDATE task SET status='waiting_user' WHERE id=?").run(taskId);
      this.event(taskId, 'approval.requested', { id, summary, expires, version: run.version });
      this.queuePush(taskId, 'approval', now, id);
      return { id, summary, expires };
    });
  }

  approvalForRun(runId: string, device: string, id: string, now: number) {
    return this.db.prepare(`SELECT a.decision FROM approval a JOIN run r ON r.id=a.runId
      JOIN task t ON t.id=r.taskId WHERE r.id=? AND r.device=? AND a.id=? AND a.version=t.version
      AND r.expires>? AND a.expires>? AND t.status IN ('running','waiting_user')
      AND NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id)`)
      .get(runId, device, id, now, now);
  }

  consumeApproval(runId: string, device: string, id: string, now: number) {
    return this.transaction(() => {
      if (this.approvalForRun(runId, device, id, now)?.decision !== 'approved') return false;
      return this.db.prepare('INSERT OR IGNORE INTO approval_use VALUES(?)').run(id).changes === 1;
    });
  }

  progress(runId: string, device: string, now: number, seq: number, message: string) {
    return this.transaction(() => {
      const run = this.db.prepare(`SELECT r.taskId FROM run r JOIN task t ON t.id=r.taskId
        WHERE r.id=? AND r.device=? AND r.expires>? AND t.version=r.version
        AND (t.status='running' OR (t.status='waiting_user' AND EXISTS(
          SELECT 1 FROM approval a WHERE a.runId=r.id AND a.version=r.version AND a.decision IS NULL AND a.expires>?
        )))
        AND NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id)`)
        .get(runId, device, now, now);
      if (!run) return false;
      const receipt = this.db.prepare('SELECT message FROM run_progress WHERE run_id=? AND device_seq=?')
        .get(runId, seq);
      if (receipt) return receipt.message === message;
      const prior = this.db.prepare('SELECT COALESCE(MAX(device_seq),0) AS seq FROM run_progress WHERE run_id=?')
        .get(runId);
      if (seq !== Number(prior?.seq) + 1) return false;
      this.db.prepare('INSERT INTO run_progress VALUES(?,?,?)').run(runId, seq, message);
      this.event(String(run.taskId), 'run.progress', { runId, deviceSeq: seq, message });
      return true;
    });
  }

  steering(runId: string, device: string, now: number, appliedVersion?: number) {
    return this.transaction(() => {
      const run = this.db.prepare(`SELECT r.taskId,r.version,t.version AS latest FROM run r
        JOIN task t ON t.id=r.taskId WHERE r.id=? AND r.device=? AND r.expires>? AND t.status='running'
        AND NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id)`).get(runId, device, now);
      if (!run) return undefined;
      let version = Number(run.version);
      const registered = this.db.prepare('SELECT 1 FROM run_steering WHERE run_id=?').get(runId);
      if (!registered) {
        if (version !== Number(run.latest) || appliedVersion !== undefined) return undefined;
        this.db.prepare('INSERT INTO run_steering VALUES(?)').run(runId);
        this.event(String(run.taskId), 'run.steering_ready', { runId });
      }
      const instructionAfter = (prior: number) => this.db.prepare(`SELECT seq,
        json_extract(data,'$.version') AS version,json_extract(data,'$.text') AS text FROM event
        WHERE taskId=? AND type='task.instruction_added' AND json_extract(data,'$.version')=?`)
        .get(run.taskId!, prior + 1);
      if (appliedVersion !== undefined && appliedVersion !== version) {
        const applied = instructionAfter(version);
        if (!applied || appliedVersion !== applied.version) return undefined;
        this.db.prepare('UPDATE run SET version=? WHERE id=?').run(appliedVersion, runId);
        this.event(String(run.taskId), 'run.instruction_applied', { runId, version: appliedVersion });
        version = appliedVersion;
      }
      const instruction = instructionAfter(version);
      return { instruction: instruction ? {
        version: Number(instruction.version), text: String(instruction.text), messageId: runId + ':' + instruction.seq,
      } : null };
    });
  }

  renew(runId: string, device: string, now: number, leaseMs: number) {
    const lease = this.db.prepare(`UPDATE run SET expires=MIN(?, (
      SELECT deadline FROM run_deadline WHERE run_id=run.id
    )) WHERE id=? AND device=? AND expires>?
      AND NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=run.id)
      AND EXISTS(SELECT 1 FROM task WHERE task.id=run.taskId AND (task.version=run.version OR EXISTS(
        SELECT 1 FROM run_steering s WHERE s.run_id=run.id
      )) AND (task.status='running' OR (task.status='waiting_user' AND EXISTS(
        SELECT 1 FROM approval WHERE approval.runId=run.id AND decision IS NULL AND approval.expires>?)))) RETURNING expires`)
      .get(now + leaseMs, runId, device, now, now);
    return lease ? Number(lease.expires) : undefined;
  }

  stopTarget(owner: string, taskId: string) {
    return this.db.prepare(`SELECT r.id AS runId,r.device FROM run r JOIN task t ON t.id=r.taskId
      WHERE t.owner=? AND t.id=? AND (t.status IN ('pausing','cancelling') OR
          EXISTS(SELECT 1 FROM run_evidence_stop s WHERE s.run_id=r.id) OR (
          t.status='running' AND r.version<>t.version
          AND NOT EXISTS(SELECT 1 FROM run_steering s WHERE s.run_id=r.id)
          AND NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id)))`).get(owner, taskId) as
      { runId: string; device: string } | undefined;
  }

  deviceStopTargets(device: string) {
    return this.db.prepare(`SELECT r.id FROM run r JOIN task t ON t.id=r.taskId
      WHERE r.device=? AND (t.status IN ('pausing','cancelling') OR
          EXISTS(SELECT 1 FROM run_evidence_stop s WHERE s.run_id=r.id) OR (
          t.status='running' AND r.version<>t.version
          AND NOT EXISTS(SELECT 1 FROM run_steering s WHERE s.run_id=r.id)
          AND NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id)))`).all(device);
  }

  acknowledgeStop(runId: string, device: string, now: number) {
    return this.transaction(() => {
      const run = this.db.prepare(`SELECT r.taskId,t.status FROM run r JOIN task t ON t.id=r.taskId
        WHERE r.id=? AND r.device=? AND r.expires>? AND (t.status IN ('pausing','cancelling') OR
          EXISTS(SELECT 1 FROM run_evidence_stop s WHERE s.run_id=r.id) OR (
          t.status='running' AND r.version<>t.version
          AND NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id)))`).get(runId, device, now);
      if (!run) return false;
      const taskId = String(run.taskId);
      if (run.status === 'pausing' || run.status === 'cancelling') {
        this.finishStoppedRun(runId, taskId, run.status === 'pausing');
      } else if (this.runEvidenceStopping(runId)) {
        this.finishRejectedEvidence(runId, taskId);
      } else {
        this.finishSupersededRun(runId, taskId);
      }
      return true;
    });
  }

  private finishSupersededRun(runId: string, taskId: string) {
    this.db.prepare('DELETE FROM run WHERE id=?').run(runId);
    this.db.prepare("UPDATE task SET status='queued' WHERE id=?").run(taskId);
    this.event(taskId, 'run.superseded', { runId });
  }

  private finishStoppedRun(runId: string, taskId: string, paused: boolean) {
    this.db.prepare('DELETE FROM run WHERE id=?').run(runId);
    this.db.prepare('UPDATE task SET status=? WHERE id=?').run(paused ? 'paused' : 'cancelled', taskId);
    this.event(taskId, paused ? 'task.paused' : 'task.cancelled', { runId });
  }

  finish(runId: string, device: string, now: number, outcome: RunOutcome) {
    return this.transaction(() => {
      const digest = createHash('sha256').update(JSON.stringify([
        outcome.status, outcome.result, outcome.artifact?.name, outcome.artifact?.text,
        ...(outcome.artifact?.mime ? [outcome.artifact.mime] : []),
      ])).digest('hex');
      const receipt = this.db.prepare('SELECT outcome_hash FROM run_receipt WHERE id=? AND device=?')
        .get(runId, device);
      if (receipt) return receipt.outcome_hash === digest;
      const row = this.db.prepare(`SELECT r.taskId, r.version AS runVersion, t.version, t.status,t.goal,
        EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id) AS staleInputs
        FROM run r JOIN task t ON r.taskId=t.id WHERE r.id=? AND r.device=? AND r.expires>?`)
        .get(runId, device, now);
      if (!row || (row.status === 'waiting_user' && !row.staleInputs)) return false;
      if (outcome.artifact?.mime && !/^\/observe [a-z0-9_-]{1,32} --window w-[0-9]{1,20} --instance [a-f0-9]{64} --visual$/.test(String(row.goal))) return false;
      const taskId = String(row.taskId);
      if (row.status === 'cancelling' || row.status === 'pausing') {
        this.finishStoppedRun(runId, taskId, row.status === 'pausing');
        return false;
      }
      const pendingReview = outcome.status === 'succeeded' && !row.staleInputs && row.runVersion === row.version &&
        Boolean(this.db.prepare('SELECT 1 FROM task_review WHERE task_id=?').get(taskId));
      if (pendingReview) {
        this.db.prepare('DELETE FROM review_input WHERE task_id=?').run(taskId);
        this.db.prepare(`INSERT INTO review_input SELECT ?,predecessor,version FROM run_dependency WHERE run_id=?`)
          .run(taskId, runId);
      }
      if (!row.staleInputs && row.runVersion !== row.version) {
        this.finishSupersededRun(runId, taskId);
        return false;
      }
      this.db.prepare('DELETE FROM run WHERE id=?').run(runId);
      if (row.staleInputs) {
        this.db.prepare("UPDATE task SET status='waiting_user',result=? WHERE id=?")
          .run('An upstream result changed during execution. Review the run before retrying.', taskId);
        this.event(taskId, 'run.inputs_changed', { runId, status: 'waiting_user' });
        return false;
      }
      const finalStatus = pendingReview ? 'waiting_review' : outcome.status;
      this.db.prepare('UPDATE task SET status=?,result=? WHERE id=?').run(finalStatus, outcome.result, taskId);
      if (outcome.status === 'succeeded' && outcome.artifact) {
        const { name, text, mime } = outcome.artifact;
        const content = Buffer.from(text, mime ? 'base64' : 'utf8');
        const id = randomUUID();
        const sha256 = createHash('sha256').update(content).digest('hex');
        this.db.prepare('INSERT INTO artifact VALUES(?,?,?,?,?,?,?)')
          .run(id, taskId, runId, name, sha256, content.length, content);
        this.db.prepare('INSERT INTO artifact_version VALUES(?,?)').run(id, row.version!);
        if (mime) this.db.prepare('INSERT INTO artifact_image VALUES(?,?)').run(id, now + windowImageLifetimeMs);
        this.event(taskId, 'artifact.created', { id, taskId, runId, name, sha256, size: content.length, version: row.version });
      }
      this.db.prepare('INSERT INTO run_receipt VALUES(?,?,?)').run(runId, device, digest);
      this.event(taskId, 'run.finished', { runId, status: finalStatus, result: outcome.result });
      return true;
    });
  }

  updateDeviceReadiness(now: number) {
    return this.transaction(() => {
      const tasks = this.db.prepare(`WITH availability AS MATERIALIZED (
        SELECT t.id,CASE WHEN EXISTS (
          SELECT 1 FROM device d JOIN device_presence p ON p.device_id=d.id
          LEFT JOIN device_desktop_apps a ON a.device_id=d.id
          WHERE d.owner=t.owner AND d.workspace=t.workspace AND d.revoked=0 AND p.last_seen>=?
          AND NOT EXISTS(SELECT 1 FROM device_pause pause WHERE pause.device_id=d.id)
          AND NOT EXISTS(SELECT 1 FROM device_interruption i WHERE i.device_id=d.id)
          AND (p.capability IS NULL OR p.capability=CASE
            WHEN substr(t.goal,1,9)='/preview ' THEN 'document.preview'
            WHEN substr(t.goal,1,9)='/observe ' OR substr(t.goal,1,7)='/click ' THEN 'computer.observe'
            ELSE 'agent.acp' END)
          AND (p.capability='agent.acp' OR (
            NOT EXISTS(SELECT 1 FROM task_app_evidence e WHERE e.task_id=t.id)
            AND NOT EXISTS(SELECT 1 FROM task_memory_input m WHERE m.task_id=t.id)))
          AND NOT EXISTS(SELECT 1 FROM task_desktop_device target WHERE target.task_id=t.id AND target.device_id<>d.id)
          AND (a.aliases IS NULL OR EXISTS(SELECT 1 FROM json_each(a.aliases) j WHERE
            substr(t.goal || ' ',1,length('/observe ' || j.value || ' '))='/observe ' || j.value || ' '
            OR substr(t.goal || ' ',1,length('/click ' || j.value || ' '))='/click ' || j.value || ' '))
        ) THEN 'queued' ELSE 'waiting_device' END AS next_status
        FROM task t WHERE t.status IN ('queued','waiting_device')
      )
      UPDATE task SET status=availability.next_status FROM availability
      WHERE task.id=availability.id AND task.status<>availability.next_status
      RETURNING id,status`).all(now - 45_000);
      for (const task of tasks) {
        this.event(String(task.id), task.status === 'queued' ? 'task.device_available' : 'task.waiting_device', {
          status: task.status,
        });
      }
      return tasks.length;
    });
  }

  expire(now: number) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM device_claim WHERE expires<=?').run(now);
      this.db.prepare('DELETE FROM artifact WHERE id IN (SELECT artifact_id FROM artifact_image WHERE expires<=?)').run(now);
      const approvals = this.db.prepare(`SELECT a.id,a.runId,a.taskId,a.expires FROM approval a
        JOIN run r ON r.id=a.runId JOIN task t ON t.id=a.taskId
        WHERE a.decision IS NULL AND a.expires<=? AND r.expires>?
        AND t.status='waiting_user' AND a.version=r.version AND r.version=t.version
        AND NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id)
        AND NOT EXISTS(SELECT 1 FROM run_evidence_stop s WHERE s.run_id=r.id)`).all(now, now);
      for (const approval of approvals) {
        const taskId = String(approval.taskId);
        this.db.prepare('DELETE FROM run WHERE id=?').run(approval.runId!);
        this.db.prepare("UPDATE task SET status='failed',result=? WHERE id=?")
          .run('Required approval expired before a decision was made.', taskId);
        this.event(taskId, 'approval.expired', {
          approvalId: approval.id, runId: approval.runId, expires: approval.expires, status: 'failed',
        });
      }
      const rows = this.db.prepare(`SELECT r.id, r.taskId, t.status,r.expires=d.deadline AS deadlineReached,
        EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id) AS staleInputs FROM run r
        JOIN task t ON r.taskId=t.id JOIN run_deadline d ON d.run_id=r.id WHERE r.expires<=?`).all(now);
      for (const row of rows) {
        const taskId = String(row.taskId);
        if (row.status === 'waiting_user' && this.runEvidenceStopping(String(row.id))) {
          this.finishRejectedEvidence(String(row.id), taskId);
          continue;
        }
        const status = row.status === 'cancelling' ? 'cancelled' : 'waiting_user';
        this.db.prepare('DELETE FROM run WHERE id=?').run(row.id!);
        this.db.prepare('UPDATE task SET status=? WHERE id=?').run(status, taskId);
        const inputsChanged = row.staleInputs && status === 'waiting_user';
        if (inputsChanged) this.db.prepare('UPDATE task SET result=? WHERE id=?')
          .run('An upstream result changed during execution. Review the run before retrying.', taskId);
        const timedOut = status === 'waiting_user' && Boolean(row.deadlineReached);
        if (timedOut && !inputsChanged) this.db.prepare('UPDATE task SET result=? WHERE id=?')
          .run('The run reached its time limit. Review the device before retrying.', taskId);
        const event = inputsChanged ? 'run.inputs_changed' : timedOut ? 'run.deadline_exceeded' : 'run.lease_expired';
        this.event(taskId, event, { runId: row.id, status });
      }
      return approvals.length + rows.length;
    });
  }
}
