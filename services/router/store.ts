import { sqliteTransaction } from '../../packages/storage/sqlite.ts';
import { DispatchRepository } from './persistence/dispatch-repository.ts';
import { DeviceRepository } from './persistence/device-repository.ts';
import { TaskReadRepository } from './persistence/task-read-repository.ts';
import { initializeTaskSchema } from './persistence/task-schema.ts';
import { IdempotencyConflict, StaleRoutingEvidence } from './domain/idempotency.ts';
import { MobileRepository } from './persistence/mobile-repository.ts';
import { orderWorkflow, resolveWorkflowWindow, workflowActionGoal, workflowSteps } from './domain/workflow.ts';
import type { Decision, RouteRequest } from './harness.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { PredecessorInput, Run, RunOutcome, Task, TaskAttachment, TaskMemoryInput, WorkerConfiguration, WorkflowAction, WorkflowStep } from '../../packages/protocol/task.ts';
import { displayTaskStatus, windowImageLifetimeMs } from '../../packages/protocol/task.ts';

const runLimitMs = 10 * 60_000;
const runSilenceMs = 2 * 60_000;
const queueLatencyBounds = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000, 15_000, 60_000, 300_000];

type ChannelReply = { channel: string; chat: string; thread: string; messageId: string };

export type AppEvidence = { query: string; sources: string[]; refs: { id: string; version: number }[] };

export { IdempotencyConflict };

export class TaskStore {
  private db: DatabaseSync;
  private readonly deviceRepository: DeviceRepository;
  private readonly mobileRepository: MobileRepository;
  private readonly dispatch: DispatchRepository;
  private readonly taskReads: TaskReadRepository;
  private readonly canUseChannelAppEvidence?: (owner: string, workspace: string, refs: AppEvidence['refs']) => boolean;

  constructor(path: string, canUseChannelAppEvidence?: TaskStore['canUseChannelAppEvidence']) {
    this.canUseChannelAppEvidence = canUseChannelAppEvidence;
    this.db = new DatabaseSync(path);
    this.deviceRepository = new DeviceRepository(this.db);
    this.mobileRepository = new MobileRepository(this.db);
    this.taskReads = new TaskReadRepository(this.db);
    this.dispatch = new DispatchRepository(this.db);
    try {
      initializeTaskSchema(this.db, runLimitMs);
      this.transaction(() => this.updateWorkflowReadiness());
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  private transaction<T>(operation: () => T): T {
    return sqliteTransaction(this.db, operation);
  }

  private updateWorkflowReadiness(changedTask?: string) {
    const stale = this.db.prepare(`UPDATE task SET status='waiting_user',
      result='A result used to plan this workflow changed. Ask Blazar for a new plan.'
      WHERE status IN ('queued','waiting_device','waiting_dependency','waiting_review') AND id IN (
        SELECT task_id FROM stale_workflow_step
      ) AND (? IS NULL OR id IN (
        SELECT w.task_id FROM workflow_step w JOIN workflow_source src ON src.workflow_id=w.workflow_id
        WHERE src.task_id=?
      )) RETURNING id`).all(changedTask ?? null, changedTask ?? null);
    for (const task of stale) this.event(String(task.id), 'workflow.result_outdated', { status: 'waiting_user' });
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

  private queueChannelNotice(owner: string, channel: string, chat: string, thread: string, replyId: string, text: string, now: number) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO channel_outbox VALUES(?,?,?,?,?,?,?,0)').run(id, channel, chat, replyId, text, now, now);
    this.db.prepare('INSERT INTO channel_notice_binding VALUES(?,?,?,?,?)').run(id, owner, channel, chat, thread);
  }

  private event(taskId: string, type: string, data: unknown, reply?: ChannelReply) {
    this.db.prepare('INSERT INTO event(taskId,type,data) VALUES(?,?,?)')
      .run(taskId, type, JSON.stringify(data));
    if (['run.finished', 'run.superseded', 'task.instruction_added', 'task.result_accepted'].includes(type)) {
      this.updateWorkflowReadiness(taskId);
    }
    const terminal = new Set(['run.finished', 'task.cancelled', 'run.lease_expired', 'run.device_revoked', 'approval.expired', 'run.inputs_changed', 'run.device_interrupted', 'run.deadline_exceeded', 'task.result_accepted', 'task.result_rejected', 'workflow.result_outdated']);
    if (!terminal.has(type) && type !== 'task.cancel_requested') return;
    const task = this.db.prepare('SELECT owner,status FROM task WHERE id=?').get(taskId);
    const status = String(task?.status);
    const notices: Record<string, string> = {
      succeeded: 'completed', failed: 'failed', cancelled: 'was cancelled', waiting_user: 'needs attention', waiting_review: 'needs result review',
    };
    const notice = notices[status];
    if (!notice) return;
    if (status === 'cancelled') {
      const target = this.db.prepare(`DELETE FROM channel_cancel_reply WHERE task_id=?
        RETURNING channel,chat,thread,message_id AS messageId`).get(taskId) as ChannelReply | undefined;
      reply ??= target;
    }
    const routes = this.db.prepare('SELECT channel,chat,thread FROM channel_thread WHERE task_id=?').all(taskId);
    const now = Date.now();
    this.queuePush(taskId, 'task_update', now);
    const text = `Blazar task ${notice}. Open Blazar to view details. Task: ${taskId}`;
    for (const route of routes) {
      const thread = String(route.thread);
      const messageId = reply && reply.channel === route.channel && reply.chat === route.chat && reply.thread === thread
        ? reply.messageId : thread;
      this.queueChannelNotice(String(task?.owner), String(route.channel), String(route.chat), thread, messageId, text, now);
    }
  }

  get(...args: Parameters<TaskReadRepository['get']>) {
    return this.taskReads.get(...args);
  }

  eventCursor(...args: Parameters<TaskReadRepository['eventCursor']>) {
    return this.taskReads.eventCursor(...args);
  }

  eventReplayFloor(...args: Parameters<TaskReadRepository['eventReplayFloor']>) {
    return this.taskReads.eventReplayFloor(...args);
  }

  pruneProgressEvents(before: number, limit = -1) {
    return this.transaction(() => {
      const latestRemoved = this.db.prepare(`SELECT MAX(seq) AS last FROM (
        SELECT seq FROM progress_event_time WHERE created_at<? ORDER BY seq LIMIT ?
      )`).get(before, limit);
      if (latestRemoved?.last == null) return 0;
      const { changes } = this.db.prepare(`DELETE FROM event WHERE seq IN (
        SELECT seq FROM progress_event_time WHERE created_at<? AND seq<=?
      )`).run(before, latestRemoved.last);
      this.db.prepare(`INSERT INTO event_retention VALUES(1,?) ON CONFLICT(id)
        DO UPDATE SET replay_floor=MAX(replay_floor,excluded.replay_floor)`).run(latestRemoved.last);
      return Number(changes);
    });
  }

  snapshot(...args: Parameters<TaskReadRepository['snapshot']>) {
    return this.taskReads.snapshot(...args);
  }

  taskAttachment(...args: Parameters<TaskReadRepository['taskAttachment']>) {
    return this.taskReads.taskAttachment(...args);
  }

  artifact(...args: Parameters<TaskReadRepository['artifact']>) {
    return this.taskReads.artifact(...args);
  }

  latestTaskText(...args: Parameters<TaskReadRepository['latestTaskText']>) {
    return this.taskReads.latestTaskText(...args);
  }

  timeline(...args: Parameters<TaskReadRepository['timeline']>) {
    return this.taskReads.timeline(...args);
  }

  recentTaskEventTypes(...args: Parameters<TaskReadRepository['recentTaskEventTypes']>) {
    return this.taskReads.recentTaskEventTypes(...args);
  }

  events(...args: Parameters<TaskReadRepository['events']>) {
    return this.taskReads.events(...args);
  }

  findRouterTasks(...args: Parameters<TaskReadRepository['findRouterTasks']>) {
    return this.taskReads.findRouterTasks(...args);
  }

  recentConversation(...args: Parameters<TaskReadRepository['recentConversation']>) {
    return this.taskReads.recentConversation(...args);
  }

  routingDecision(owner: string, key: string, request: RouteRequest, decision?: Decision, caller = 'admin'): Decision | undefined {
    const fingerprint = JSON.stringify(request.usePersonalMemory
      ? [request.workspace, request.text, true] : [request.workspace, request.text]);
    if (decision) {
      this.db.prepare('INSERT OR IGNORE INTO routing_decision(owner,caller,key,request,decision) VALUES(?,?,?,?,?)')
        .run(owner, caller, key, fingerprint, JSON.stringify(decision));
    }
    const row = this.db.prepare('SELECT request,decision FROM routing_decision WHERE owner=? AND caller=? AND key=?').get(owner, caller, key);
    if (!row) return undefined;
    if (row.request !== fingerprint) throw new IdempotencyConflict();
    this.assertRoutingEvidence(owner, caller, key);
    return JSON.parse(String(row.decision)) as Decision;
  }

  private assertRoutingEvidence(owner: string, caller: string, key: string) {
    if (this.db.prepare(`SELECT 1 FROM routing_task_evidence e LEFT JOIN task t ON t.id=e.task_id
      WHERE e.owner=? AND e.caller=? AND e.request_key=?
      AND (t.status IS NOT 'succeeded' OR t.version IS NOT e.version)`).get(owner, caller, key)) {
      throw new StaleRoutingEvidence();
    }
  }

  persistRoutingDecision(owner: string, caller: string, key: string, request: RouteRequest, decision: Decision, taskEvidence: ReadonlyMap<string, number> = new Map()) {
    return this.transaction(() => {
      const saved = this.routingDecision(owner, key, request, decision, caller)!;
      for (const [taskId, version] of taskEvidence) {
        this.db.prepare('INSERT OR IGNORE INTO routing_task_evidence VALUES(?,?,?,?,?)')
          .run(owner, caller, key, taskId, version);
      }
      if (saved.kind === 'create_task') {
        this.createTask(owner, caller === 'admin' ? 'conversation' : 'conversation:' + caller,
          key, request.workspace, saved.goal ?? request.text);
      }
      return saved;
    });
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

  leaseDingTalkNotice(channel: string, now: number, chats: readonly string[]) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM dingtalk_reply_secret WHERE expires<=?').run(now);
      const notice = this.db.prepare(`SELECT o.id,o.chat,o.message_id AS messageId,o.text,w.expires,w.sealed
        FROM channel_outbox o JOIN dingtalk_reply_secret w ON w.channel=o.channel
          AND w.chat=o.chat AND w.message_id=o.message_id
        WHERE o.channel=? AND o.delivered=0 AND o.retry<=? AND w.expires>?
        AND o.chat IN (SELECT value FROM json_each(?)) ORDER BY o.created,o.rowid LIMIT 1`)
        .get(channel, now, now, JSON.stringify(chats)) as
        { id: string; chat: string; messageId: string; text: string; expires: number; sealed: string } | undefined;
      if (notice) this.db.prepare('UPDATE channel_outbox SET delivered=-2 WHERE id=?').run(notice.id);
      return notice;
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
        SELECT notice.rowid FROM channel_notice_binding b JOIN channel_outbox notice ON notice.id=b.notice
        WHERE b.owner=c.owner AND b.channel=c.channel AND b.chat=c.chat AND b.thread=c.thread
        ORDER BY notice.created DESC,notice.rowid DESC LIMIT 1
      )
      LEFT JOIN channel_reply_window w ON w.channel=o.channel AND w.chat=o.chat AND w.message_id=o.message_id
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
      this.db.prepare(`DELETE FROM channel_outbox WHERE delivered=0 AND id IN (
        SELECT notice FROM channel_notice_binding WHERE owner=? AND channel=? AND chat=? AND thread=?
      )`).run(owner, link.channel, link.chat, link.thread);
      this.event(taskId, 'task.channel_unlinked', { channel: link.channel });
      return true;
    });
  }

  channelAttachmentTask(owner: string, channel: string, workspace: string, message: { id: string; chat: string; thread: string; taskId?: string }) {
    return this.db.prepare(`SELECT t.id,t.status FROM channel_thread c JOIN task t ON t.id=c.task_id
      WHERE c.owner=? AND c.channel=? AND c.chat=? AND t.workspace=?
      AND (CASE WHEN ? IS NULL THEN c.thread=? ELSE t.id=? END)
      AND t.status NOT IN ('cancelled','cancelling','paused','pausing')
      AND substr(t.goal,1,9) NOT IN ('/observe ','/preview ') AND substr(t.goal,1,7)<>'/click '
      AND NOT EXISTS(SELECT 1 FROM channel_message m WHERE m.owner=c.owner AND m.channel=c.channel AND m.message=?)`)
      .get(owner, channel, message.chat, workspace, message.taskId ?? null, message.thread, message.taskId ?? null, message.id);
  }

  expectChannelAttachment(owner: string, channel: string, workspace: string,
                          message: { id: string; chat: string; thread: string; taskId: string; sender: string }, now: number) {
    return this.transaction(() => {
      if (!this.channelAttachmentTask(owner, channel, workspace, message)) return false;
      this.db.prepare('DELETE FROM channel_attachment_intent WHERE expires<=?').run(now);
      this.db.prepare('INSERT INTO channel_message VALUES(?,?,?)').run(owner, channel, message.id);
      this.db.prepare(`INSERT INTO channel_attachment_intent VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(owner,channel,chat,sender) DO UPDATE SET
        task_id=excluded.task_id,command_id=excluded.command_id,expires=excluded.expires`)
        .run(owner, channel, message.chat, message.sender, message.taskId, message.id, now + 5 * 60_000);
      return true;
    });
  }

  channelAttachmentIntent(owner: string, channel: string, chat: string, sender: string, now: number) {
    const row = this.db.prepare(`SELECT task_id,command_id FROM channel_attachment_intent
      WHERE owner=? AND channel=? AND chat=? AND sender=? AND expires>?`).get(owner, channel, chat, sender, now);
    return row && { taskId: String(row.task_id), commandId: String(row.command_id) };
  }

  bindChannelAttachment(owner: string, channel: string, workspace: string,
                        file: { id: string; chat: string; thread: string; sender: string }, now: number) {
    return this.transaction(() => {
      const intent = this.channelAttachmentIntent(owner, channel, file.chat, file.sender, now);
      const prior = this.db.prepare(`SELECT command_id FROM channel_attachment_receipt
        WHERE owner=? AND channel=? AND message=?`).get(owner, channel, file.id);
      if (prior && prior.command_id !== intent?.commandId) return undefined;
      if (!intent || !this.channelAttachmentTask(owner, channel, workspace, { ...file, taskId: intent.taskId })) {
        if (!prior) this.db.prepare('INSERT OR IGNORE INTO channel_message VALUES(?,?,?)').run(owner, channel, file.id);
        return undefined;
      }
      if (!prior) this.db.prepare('INSERT INTO channel_attachment_receipt VALUES(?,?,?,?)')
        .run(owner, channel, file.id, intent.commandId);
      return intent;
    });
  }

  addChannelAttachment(owner: string, channel: string, workspace: string, taskId: string,
                       message: { id: string; chat: string; thread: string; taskId?: string }, attachment: TaskAttachment,
                       intent?: { sender: string; commandId: string }) {
    return this.transaction(() => {
      const task = this.channelAttachmentTask(owner, channel, workspace, message);
      if (task?.id !== taskId) return false;
      if (intent && this.channelAttachmentIntent(owner, channel, message.chat, intent.sender, Date.now())?.commandId !== intent.commandId) {
        return false;
      }
      const refs = this.appEvidence(taskId);
      if (refs && this.canUseChannelAppEvidence?.(owner, workspace, refs) !== true) return false;
      const totals = this.db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(text AS BLOB))),0) AS bytes
        FROM task_attachment WHERE task_id=?`).get(taskId)!;
      const size = Buffer.byteLength(attachment.text);
      if (Number(totals.count) >= 4 || Number(totals.bytes) + size > 16_384) return false;
      this.db.prepare('INSERT INTO channel_message VALUES(?,?,?)').run(owner, channel, message.id);
      if (intent) {
        this.db.prepare('DELETE FROM channel_attachment_intent WHERE owner=? AND channel=? AND chat=? AND sender=?')
          .run(owner, channel, message.chat, intent.sender);
        this.db.prepare('DELETE FROM channel_attachment_receipt WHERE owner=? AND channel=? AND message=?')
          .run(owner, channel, message.id);
      }
      this.db.prepare('INSERT INTO task_attachment VALUES(?,?,?,?)').run(taskId, totals.count!, attachment.name, attachment.text);
      const run = this.db.prepare('SELECT id FROM run WHERE taskId=?').get(taskId);
      if (run) this.db.prepare('DELETE FROM run_steering WHERE run_id=?').run(run.id!);
      const updated = this.db.prepare('UPDATE task SET status=?,version=version+1,result=NULL WHERE id=? RETURNING version')
        .get(run ? 'running' : 'queued', taskId)!;
      this.event(taskId, 'task.attachment_added', {
        channel, name: attachment.name, size, sha256: createHash('sha256').update(attachment.text).digest('hex'),
        version: updated.version,
      });
      if (task.status === 'succeeded') this.invalidateCompletedDescendants(taskId);
      this.updateWorkflowReadiness(taskId);
      return true;
    });
  }

  receiveChannelMessage(owner: string, channel: string, workspace: string,
                        message: { id: string; chat: string; thread: string; root: boolean; text: string; taskId?: string; replyExpires?: number }, weixinContext?: string, sealedDingTalkReply?: string) {
    if (message.text.startsWith('/observe ') || message.text.startsWith('/click ')) return;
    return this.transaction(() => {
      const existing = this.db.prepare('INSERT OR IGNORE INTO channel_message VALUES(?,?,?)')
        .run(owner, channel, message.id);
      if (!existing.changes) return;
      if (sealedDingTalkReply && message.replyExpires !== undefined) {
        this.db.prepare('INSERT INTO dingtalk_reply_secret VALUES(?,?,?,?,?)')
          .run(channel, message.chat, message.id, sealedDingTalkReply, message.replyExpires);
      }
      if (weixinContext) {
        this.db.prepare(`INSERT INTO weixin_reply_context VALUES(?,?,?,?,?) ON CONFLICT(owner,channel,chat)
          DO UPDATE SET token=excluded.token,expires=excluded.expires`)
          .run(owner, channel, message.chat, weixinContext, Date.now() + 10 * 60_000);
      }
      const key = [owner, channel, message.chat, message.thread] as const;
      const cancel = message.text === '/cancel';
      const statusQuery = message.text === '/status' || message.text === '/状态';
      const pause = message.text === '/pause' || message.text === '/暂停';
      const resume = message.text === '/resume' || message.text === '/继续';
      const retry = message.text === '/retry' || message.text === '/重试';
      const review = /^\/(accept|reject|验收|退回)(?:\s+(.*))?$/.exec(message.text);
      if ((cancel || statusQuery || pause || resume || retry || review) && message.root) return;
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
      if (cancel || statusQuery || pause || resume || retry || review) {
        const previous = String(link.status);
        if (pause) this.pauseTask(taskId, previous, { channel });
        if ((resume || retry) && canContinue()) this.requeueTask(taskId, previous, retry ? 'retry' : 'resume', { channel });
        const current = this.get(owner, taskId)!;
        const now = Date.now();
        const thread = String(link.thread);
        let reply: ChannelReply | undefined;
        if (message.replyExpires !== undefined && message.replyExpires > now) {
          this.db.prepare('INSERT OR IGNORE INTO channel_reply_window VALUES(?,?,?,?)')
            .run(channel, message.chat, message.id, message.replyExpires);
          reply = { channel, chat: message.chat, thread, messageId: message.id };
        }
        if (cancel && this.cancelTask(taskId, previous, { channel }, reply)) return;
        if (review && /^[1-9]\d*$/.test(review[2] ?? '') && Number(review[2]) === current.version) {
          const accepted = review[1] === 'accept' || review[1] === '验收';
          if ((!accepted || canContinue()) && this.reviewResult(current, accepted, { channel }, reply)) return;
        }
        if (message.replyExpires !== undefined && !reply) return;
        const replyId = reply?.messageId ?? thread;
        const chinese = ['/状态', '/暂停', '/继续', '/重试'].includes(message.text) || review?.[1] === '验收' || review?.[1] === '退回';
        const state = displayTaskStatus(current.status, chinese);
        const text = chinese ? `Blazar 任务${state}。版本 ${current.version}。任务 ID ${link.id}`
          : `Blazar task status: ${state}. Version: ${current.version}. Task: ${link.id}`;
        this.queueChannelNotice(owner, channel, message.chat, thread, replyId, text, now);
        return;
      }
      if (['cancelled', 'cancelling', 'paused', 'pausing'].includes(String(link.status)) || !canContinue() ||
          this.db.prepare('SELECT 1 FROM stale_workflow_step WHERE task_id=?').get(taskId)) return;
      this.appendInstruction(taskId, message.text, String(link.status), { channel });
    });
  }

  private reviewResult(task: Task, accepted: boolean, metadata: Record<string, string> = {}, reply?: ChannelReply) {
    const { id: taskId, version } = task;
    if (accepted && this.db.prepare('SELECT 1 FROM stale_workflow_step WHERE task_id=?').get(taskId)) return false;
    const reconciliation = task.status === 'waiting_user' && this.db.prepare(
      'SELECT inputs FROM desktop_reconciliation WHERE task_id=?').get(taskId);
    if ((!reconciliation && task.status !== 'waiting_review') || (reconciliation && metadata.channel) ||
        this.db.prepare('SELECT 1 FROM run WHERE taskId=?').get(taskId)) return false;
    if (accepted && reconciliation && this.db.prepare(`SELECT 1 FROM json_each(?) i
      LEFT JOIN task p ON p.id=json_extract(i.value,'$[0]')
      WHERE p.status IS NOT 'succeeded' OR p.version IS NOT json_extract(i.value,'$[1]')`).get(reconciliation.inputs!)) return false;
    if (accepted && this.db.prepare(`SELECT 1 FROM review_input i JOIN task p ON p.id=i.predecessor
      WHERE i.task_id=? AND (p.status!='succeeded' OR p.version<>i.version)`).get(taskId)) return false;
    const status = accepted ? 'succeeded' : 'failed';
    const result = reconciliation
      ? accepted ? 'The user confirmed that the click took effect.' : 'The user confirmed that the click did not take effect.'
      : task.result;
    this.db.prepare('UPDATE task SET status=?,version=version+1,result=? WHERE id=?').run(status, result, taskId);
    if (accepted) {
      this.db.prepare(`UPDATE artifact_version SET task_version=? WHERE task_version=?
        AND artifact_id IN (SELECT id FROM artifact WHERE taskId=?)`).run(version + 1, version, taskId);
    }
    if (reconciliation) this.db.prepare('DELETE FROM desktop_reconciliation WHERE task_id=?').run(taskId);
    this.db.prepare('DELETE FROM review_input WHERE task_id=?').run(taskId);
    this.event(taskId, accepted ? 'task.result_accepted' : 'task.result_rejected', { status, ...metadata }, reply);
    return true;
  }

  private pauseTask(taskId: string, previousStatus: string, metadata: Record<string, string> = {}) {
    if (this.db.prepare('SELECT 1 FROM desktop_reconciliation WHERE task_id=?').get(taskId)) return false;
    if (!['queued', 'running', 'waiting_user', 'waiting_dependency', 'waiting_device'].includes(previousStatus)) return false;
    const live = this.db.prepare('SELECT 1 FROM run WHERE taskId=?').get(taskId);
    const status = live ? 'pausing' : 'paused';
    this.db.prepare('UPDATE task SET status=?,version=version+1 WHERE id=?').run(status, taskId);
    this.event(taskId, 'task.pause_requested', { status, ...metadata });
    return true;
  }

  private requeueTask(taskId: string, previousStatus: string, action: 'resume' | 'retry', metadata: Record<string, string> = {}) {
    if (this.db.prepare('SELECT 1 FROM stale_workflow_step WHERE task_id=?').get(taskId)) return false;
    if (this.db.prepare('SELECT 1 FROM desktop_reconciliation WHERE task_id=?').get(taskId)) return false;
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

  private cancelTask(taskId: string, priorStatus: string, metadata: Record<string, string> = {}, reply?: ChannelReply) {
    if (!['queued', 'running', 'waiting_user', 'waiting_dependency', 'waiting_device', 'pausing', 'paused', 'waiting_review'].includes(priorStatus)) {
      return false;
    }
    const liveRun = this.db.prepare('SELECT 1 FROM run WHERE taskId=?').get(taskId);
    if (reply) this.db.prepare(`INSERT INTO channel_cancel_reply VALUES(?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET channel=excluded.channel,chat=excluded.chat,
        thread=excluded.thread,message_id=excluded.message_id`)
      .run(taskId, reply.channel, reply.chat, reply.thread, reply.messageId);
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
         memoryInputs?: TaskMemoryInput[], appEvidence?: AppEvidence, attachments?: TaskAttachment[], copiedFromTask?: string): Task {
    return this.transaction(() => this.createTask(owner, source, key, workspace, goal, desktopDevice,
      memoryInputs, appEvidence, attachments, copiedFromTask));
  }

  private createTask(owner: string, source: string, key: string, workspace: string, goal: string, desktopDevice?: string,
         memoryInputs?: TaskMemoryInput[], appEvidence?: AppEvidence, attachments?: TaskAttachment[], copiedFromTask?: string): Task {
    const parameters: unknown[] = appEvidence
      ? [workspace, goal, { query: appEvidence.query, sources: appEvidence.sources, usePersonalMemory: Boolean(memoryInputs) }]
      : memoryInputs
      ? [workspace, goal, desktopDevice ?? null, { usePersonalMemory: true }]
      : desktopDevice ? [workspace, goal, desktopDevice] : [workspace, goal];
    const attachmentRefs = attachments?.map(({ name, text }) => ({
      name, sha256: createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text),
    }));
    if (attachmentRefs?.length) parameters.push({ attachments: attachmentRefs });
    if (copiedFromTask) parameters.push({ copiedFromTask });
    const fingerprint = JSON.stringify(parameters);
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
        .run(id, position, input.id, input.version, '');
    }
    if (appEvidence) {
      if (!appEvidence.refs.length) throw new Error('No authorized application evidence was found');
      this.db.prepare('INSERT INTO task_app_evidence VALUES(?,?)').run(id, JSON.stringify(appEvidence.refs));
    }
    for (const [position, attachment] of (attachments ?? []).entries()) {
      this.db.prepare('INSERT INTO task_attachment VALUES(?,?,?,?)')
        .run(id, position, attachment.name, attachment.text);
    }
    this.event(id, 'task.created', { goal, workspace, ...(desktopDevice && { desktopDevice }),
      ...(memoryInputs?.length && { memoryInputs: memoryInputs.map(({ id, version }) => ({ id, version })) }),
      ...(appEvidence && { appEvidence: appEvidence.refs }),
      ...(attachmentRefs?.length && { attachments: attachmentRefs }),
      ...(copiedFromTask && { copiedFromTask }),
    });
    return this.get(owner, id)!;
  }

  appEvidence(taskId: string) {
    const row = this.db.prepare('SELECT refs FROM task_app_evidence WHERE task_id=?').get(taskId);
    return row ? JSON.parse(String(row.refs)) as { id: string; version: number }[] : undefined;
  }

  personalEvidence(taskId: string) {
    return this.db.prepare('SELECT memory_id AS id,version FROM task_memory_input WHERE task_id=? ORDER BY position')
      .all(taskId) as { id: string; version: number }[];
  }

  personalEvidenceTasks(owner: string) {
    return this.db.prepare(`SELECT t.id FROM task t WHERE t.owner=?
      AND EXISTS(SELECT 1 FROM task_memory_input m WHERE m.task_id=t.id)`).all(owner).map(row => String(row.id));
  }

  appEvidenceTasks(owner: string) {
    return this.db.prepare(`SELECT e.task_id FROM task_app_evidence e JOIN task t ON t.id=e.task_id
      WHERE t.owner=?`).all(owner).map(row => String(row.task_id));
  }

  runTaskId(runId: string, device: string) {
    return this.db.prepare('SELECT taskId FROM run WHERE id=? AND device=?').get(runId, device)?.taskId as string | undefined;
  }

  pendingMemoryTasks() {
    return this.db.prepare(`SELECT t.id,t.owner,t.workspace,e.refs AS app_refs,r.id AS run_id,r.device,
      (SELECT json_group_array(json_object('id',memory_id,'version',version)) FROM (
        SELECT memory_id,version FROM task_memory_input WHERE task_id=t.id ORDER BY position
      )) AS personal_refs
    FROM task t LEFT JOIN task_app_evidence e ON e.task_id=t.id LEFT JOIN run r ON r.taskId=t.id
    WHERE t.status IN ('queued','waiting_device','waiting_dependency','waiting_review','running','waiting_user')
      AND (e.task_id IS NOT NULL OR EXISTS(SELECT 1 FROM task_memory_input m WHERE m.task_id=t.id))
      AND ((r.id IS NULL AND t.status IN ('queued','waiting_device','waiting_dependency','waiting_review'))
        OR (r.id IS NOT NULL AND t.status IN ('running','waiting_user')
          AND NOT EXISTS(SELECT 1 FROM run_evidence_stop s WHERE s.run_id=r.id)))`).all().map(row => ({
      id: String(row.id), owner: String(row.owner), workspace: String(row.workspace),
      appRefs: row.app_refs === null ? undefined : String(row.app_refs), personalRefs: String(row.personal_refs),
      run: row.run_id === null ? undefined : { id: String(row.run_id), device: String(row.device) },
    }));
  }

  suspendTaskForMemory(taskId: string) {
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

  createWorkflow(owner: string, key: string, workspace: string, steps: WorkflowStep[], appEvidence?: AppEvidence, caller?: string, proposalKey?: string) {
    const ordered = orderWorkflow(steps);
    // Mobile keys exceed the public 128-character limit to preserve existing administrator receipts.
    const requestKey = proposalKey ? 'proposal:' + createHash('sha512').update(JSON.stringify([caller ?? 'admin', proposalKey])).digest('hex')
      : caller ? 'mobile:' + createHash('sha512').update(JSON.stringify([caller, key])).digest('hex') : key;

    return this.transaction(() => {
      const fingerprint = JSON.stringify(appEvidence
        ? [workspace, steps, { query: appEvidence.query, sources: appEvidence.sources }]
        : [workspace, steps]);
      const existing = this.db.prepare('SELECT id,fingerprint FROM workflow WHERE owner=? AND request_key=?')
        .get(owner, requestKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new IdempotencyConflict();
        return { id: String(existing.id), steps: this.workflowSteps(String(existing.id)) };
      }
      if (proposalKey) {
        const identity = caller ?? 'admin';
        const proposal = this.db.prepare(`SELECT decision FROM routing_decision WHERE owner=? AND caller=? AND key=?
          AND json_extract(request,'$[0]')=?`).get(owner, identity, proposalKey, workspace);
        const saved = proposal ? JSON.parse(String(proposal.decision)) as Decision : undefined;
        if (saved?.kind !== 'propose_workflow' || JSON.stringify(workflowSteps(saved.steps)) !== JSON.stringify(steps)) {
          throw new IdempotencyConflict();
        }
        this.assertRoutingEvidence(owner, identity, proposalKey);
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO workflow VALUES(?,?,?,?)').run(id, owner, requestKey, fingerprint);
      if (proposalKey) this.db.prepare(`INSERT INTO workflow_source
        SELECT ?,task_id,version FROM routing_task_evidence WHERE owner=? AND caller=? AND request_key=?`)
        .run(id, owner, caller ?? 'admin', proposalKey);
      const tasks = new Map<string, string>();
      for (const step of ordered) {
        const name = step.key;
        const taskId = randomUUID();
        tasks.set(name, taskId);
        const status = step.needs.length ? 'waiting_dependency' : 'queued';
        const goal = step.action ? workflowActionGoal(step.action) : step.goal;
        this.db.prepare('INSERT INTO task(id,owner,workspace,goal,status) VALUES(?,?,?,?,?)')
          .run(taskId, owner, workspace, goal, status);
        if (step.action) {
          this.db.prepare('INSERT INTO task_desktop_device VALUES(?,?)').run(taskId, step.action.deviceId);
          if (step.action.kind === 'desktop.observe') this.db.prepare('INSERT INTO workflow_observation(task_id) VALUES(?)').run(taskId);
        }
        this.db.prepare('INSERT INTO workflow_step VALUES(?,?,?)').run(id, name, taskId);
        if (step.requireReview) this.db.prepare('INSERT INTO task_review VALUES(?)').run(taskId);
        if (step.runLimitSeconds !== undefined) {
          this.db.prepare('INSERT INTO task_run_budget VALUES(?,?)').run(taskId, step.runLimitSeconds);
        }
        if (step.workerCapability) this.db.prepare('INSERT INTO task_worker_capability VALUES(?,?)').run(taskId, step.workerCapability);
        for (const protocol of step.workerProtocols ?? []) {
          this.db.prepare('INSERT INTO task_worker_protocol VALUES(?,?)').run(taskId, protocol);
        }
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
          ...(step.action && { action: step.action }),
          ...(step.runLimitSeconds !== undefined && { runLimitSeconds: step.runLimitSeconds }),
          ...(step.workerCapability && { workerCapability: step.workerCapability }),
          ...(step.workerProtocols && { workerProtocols: step.workerProtocols }),
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

  command(owner: string, taskId: string, version: number, command: { action: 'cancel' | 'pause' | 'resume' | 'retry' | 'accept_result' | 'reject_result' } | { action: 'append'; text: string } | { action: 'approve' | 'deny'; approvalId: string }, key?: string, caller = 'admin') {
    return this.transaction(() => {
      const fingerprint = JSON.stringify([taskId, version, command]);
      if (key) {
        const receipt = this.db.prepare('SELECT fingerprint,response FROM command_receipt WHERE owner=? AND caller=? AND key=?')
          .get(owner, caller, key);
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
        this.db.prepare('UPDATE run_activity SET last_output=?,stalled=0 WHERE run_id=?').run(now, liveRun?.id ?? null);
        this.db.prepare("UPDATE task SET status='running' WHERE id=?").run(taskId);
        this.event(taskId, 'approval.decided', { approvalId: command.approvalId, decision });
      } else if (command.action === 'accept_result' || command.action === 'reject_result') {
        if (!this.reviewResult(task, command.action === 'accept_result')) return undefined;
      } else if (command.action === 'pause') {
        if (!this.pauseTask(taskId, task.status)) return undefined;
      } else if (command.action === 'resume' || command.action === 'retry') {
        if (!this.requeueTask(taskId, task.status, command.action)) return undefined;
      } else if (command.action === 'cancel') {
        if (!this.cancelTask(taskId, task.status)) return undefined;
      } else if (command.action === 'append') {
        if (this.db.prepare('SELECT 1 FROM stale_workflow_step WHERE task_id=?').get(taskId)) return undefined;
        if (task.goal.startsWith('/click ')) return undefined;
        if (['cancelling', 'cancelled', 'pausing', 'paused'].includes(task.status)) return undefined;
        this.appendInstruction(taskId, command.text, task.status);
      }
      const updated = this.get(owner, taskId)!;
      if (key) {
        this.db.prepare('INSERT INTO command_receipt VALUES(?,?,?,?,?)')
          .run(owner, caller, key, fingerprint, JSON.stringify(updated));
      }
      return updated;
    });
  }

  createPairing(...args: Parameters<MobileRepository['createPairing']>) {
    return this.mobileRepository.createPairing(...args);
  }

  redeemPairing(...args: Parameters<MobileRepository['redeemPairing']>) {
    return this.mobileRepository.redeemPairing(...args);
  }

  requestMobilePairing(...args: Parameters<MobileRepository['requestMobilePairing']>) {
    return this.mobileRepository.requestMobilePairing(...args);
  }

  pendingMobilePairings(...args: Parameters<MobileRepository['pendingMobilePairings']>) {
    return this.mobileRepository.pendingMobilePairings(...args);
  }

  decideMobilePairing(...args: Parameters<MobileRepository['decideMobilePairing']>) {
    return this.mobileRepository.decideMobilePairing(...args);
  }

  mobilePairingState(...args: Parameters<MobileRepository['mobilePairingState']>) {
    return this.mobileRepository.mobilePairingState(...args);
  }

  mobileIdentity(...args: Parameters<MobileRepository['mobileIdentity']>) {
    return this.mobileRepository.mobileIdentity(...args);
  }

  mobileOwner(...args: Parameters<MobileRepository['mobileOwner']>) {
    return this.mobileRepository.mobileOwner(...args);
  }

  resultGrants(...args: Parameters<MobileRepository['resultGrants']>) {
    return this.mobileRepository.resultGrants(...args);
  }

  shareTaskResult(...args: Parameters<MobileRepository['shareTaskResult']>) {
    return this.mobileRepository.shareTaskResult(...args);
  }

  canReadSharedResult(...args: Parameters<MobileRepository['canReadSharedResult']>) {
    return this.mobileRepository.canReadSharedResult(...args);
  }

  registerPush(...args: Parameters<MobileRepository['registerPush']>) {
    return this.mobileRepository.registerPush(...args);
  }

  private queuePush(...args: Parameters<MobileRepository['queuePush']>) {
    return this.mobileRepository.queuePush(...args);
  }

  leasePush(...args: Parameters<MobileRepository['leasePush']>) {
    return this.mobileRepository.leasePush(...args);
  }

  finishPush(...args: Parameters<MobileRepository['finishPush']>) {
    return this.mobileRepository.finishPush(...args);
  }

  mobileClients(...args: Parameters<MobileRepository['mobileClients']>) {
    return this.mobileRepository.mobileClients(...args);
  }

  revokeMobile(...args: Parameters<MobileRepository['revokeMobile']>) {
    return this.mobileRepository.revokeMobile(...args);
  }

  registerDevice(...args: Parameters<DeviceRepository['registerDevice']>) {
    return this.deviceRepository.registerDevice(...args);
  }

  devices(...args: Parameters<DeviceRepository['devices']>) {
    return this.deviceRepository.devices(...args);
  }

  metrics(owner: string, now: number) {
    const tasks = this.db.prepare('SELECT status,COUNT(*) AS count FROM task WHERE owner=? GROUP BY status').all(owner);
    const devices = this.devices(owner, now);
    const queue = this.db.prepare('SELECT bucket,count,total_ms FROM task_queue_latency WHERE owner=? ORDER BY bucket')
      .all(owner);
    const count = queue.reduce((sum, row) => sum + Number(row.count), 0);
    const total = queue.reduce((sum, row) => sum + Number(row.total_ms), 0);
    let cumulative = 0;
    const p95 = queue.find(row => (cumulative += Number(row.count)) >= Math.ceil(count * 0.95));
    const recovery = Object.fromEntries(this.db.prepare(`SELECT e.type,COUNT(*) AS count
      FROM task t JOIN event e ON e.taskId=t.id
      WHERE t.owner=? AND e.type IN ('run.lease_expired','run.deadline_exceeded','run.device_interrupted','run.device_revoked')
      GROUP BY e.type`).all(owner).map(row => [String(row.type), Number(row.count)]));
    const channelDelivery = this.db.prepare(`SELECT
      CASE WHEN json_valid(b.channel) THEN json_extract(b.channel,'$[0]') ELSE b.channel END AS channel,
      SUM(o.delivered=1) AS sent,SUM(o.delivered=-1) AS failed,SUM(o.delivered=-2) AS unknown,
      SUM(o.delivered=0 AND COALESCE(w.expires,o.created+600000)<=?) AS expired,
      SUM(o.delivered=0 AND COALESCE(w.expires,o.created+600000)>?) AS pending
      FROM channel_notice_binding b JOIN channel_outbox o ON o.id=b.notice
      LEFT JOIN channel_reply_window w ON w.channel=o.channel AND w.chat=o.chat AND w.message_id=o.message_id
      WHERE b.owner=? GROUP BY 1 ORDER BY 1`).all(now, now, owner);
    return {
      tasks: Object.fromEntries(tasks.map(row => [row.status, row.count])),
      channelDelivery,
      runRecovery: {
        leaseExpired: recovery['run.lease_expired'] ?? 0,
        deadlineExceeded: recovery['run.deadline_exceeded'] ?? 0,
        deviceInterrupted: recovery['run.device_interrupted'] ?? 0,
        deviceRevoked: recovery['run.device_revoked'] ?? 0,
      },
      queueLatencyMs: { count, mean: count ? total / count : null,
        p95UpperBound: p95 ? queueLatencyBounds[Number(p95.bucket)] ?? null : null },
      devices: {
        active: devices.filter(device => !device.revoked).length,
        online: devices.filter(device => device.online).length,
        interrupted: devices.filter(device => !device.revoked && device.interruptedRunId).length,
      },
    };
  }

  workspaceWorkerPolicies(...args: Parameters<DeviceRepository['workspaceWorkerPolicies']>) {
    return this.deviceRepository.workspaceWorkerPolicies(...args);
  }

  setWorkspaceWorkerPolicy(...args: Parameters<DeviceRepository['setWorkspaceWorkerPolicy']>) {
    return this.deviceRepository.setWorkspaceWorkerPolicy(...args);
  }

  recordDesktopApps(...args: Parameters<DeviceRepository['recordDesktopApps']>) {
    return this.deviceRepository.recordDesktopApps(...args);
  }

  desktopTargets(...args: Parameters<DeviceRepository['desktopTargets']>) {
    return this.deviceRepository.desktopTargets(...args);
  }

  ownsDesktopTarget(...args: Parameters<DeviceRepository['ownsDesktopTarget']>) {
    return this.deviceRepository.ownsDesktopTarget(...args);
  }

  recordDeviceActivity(...args: Parameters<DeviceRepository['recordDeviceActivity']>) {
    return this.deviceRepository.recordDeviceActivity(...args);
  }

  recordDeviceWorker(...args: Parameters<DeviceRepository['recordDeviceWorker']>) {
    return this.deviceRepository.recordDeviceWorker(...args);
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

  clearInterruption(...args: Parameters<DeviceRepository['clearInterruption']>) {
    return this.deviceRepository.clearInterruption(...args);
  }

  deviceForToken(...args: Parameters<DeviceRepository['deviceForToken']>) {
    return this.deviceRepository.deviceForToken(...args);
  }

  setDevicePaused(...args: Parameters<DeviceRepository['setDevicePaused']>) {
    return this.deviceRepository.setDevicePaused(...args);
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

  claim(owner: string, workspace: string, device: string, now: number, leaseMs: number, goalPrefix = '', excludingPrefix = '', requestId?: string, worker?: WorkerConfiguration, desktopApps?: string[], allowWorkerInputs = false) {
    return this.transaction(() => {
      const selection = this.dispatch.select({
        owner, workspace, device, now, goalPrefix, excludingPrefix, requestId, worker, desktopApps, allowWorkerInputs,
      });
      if (!selection) return undefined;
      if (selection.kind === 'replay') {
        return { ...(selection.assignment as ReturnType<TaskStore['assignment']>), replayed: true };
      }
      const { task, fingerprint, workerLimitSeconds } = selection;
      const action = /^\/(observe|click) /.test(task.goal) ? this.workflowDesktopAction(task.id) : undefined;
      let resolvedGoal: string | undefined;
      if (action && 'windowFrom' in action) {
        const input = this.db.prepare(`SELECT p.result FROM workflow_dependency d JOIN task p ON p.id=d.predecessor
          JOIN workflow_step source ON source.task_id=p.id WHERE d.task_id=? AND source.step_key=? AND p.status='succeeded'`)
          .get(task.id, action.windowFrom.step);
        const target = typeof input?.result === 'string' && resolveWorkflowWindow(input.result, action.windowFrom.title);
        if (!target) {
          this.db.prepare("UPDATE task SET status='waiting_user',result=? WHERE id=?")
            .run('The observation did not identify one accessible window with the requested title.', task.id);
          this.event(task.id, 'workflow.window_unresolved', { status: 'waiting_user' });
          if (requestId) this.dispatch.saveReceipt(device, requestId, fingerprint, null, now);
          return undefined;
        }
        resolvedGoal = workflowActionGoal(action, target);
      }
      const workerTask = !/^\/(observe|click|preview) /.test(task.goal);
      const workspaceLimitMs = workerTask && workerLimitSeconds !== undefined ? workerLimitSeconds * 1_000 : runLimitMs;
      const stepLimit = this.db.prepare('SELECT seconds FROM task_run_budget WHERE task_id=?').get(task.id);
      const limitMs = stepLimit ? Math.min(workspaceLimitMs, Number(stepLimit.seconds) * 1_000) : workspaceLimitMs;
      const run: Run = { id: randomUUID(), taskId: task.id, version: task.version, device, expires: now + Math.min(leaseMs, limitMs) };
      this.db.prepare('INSERT INTO run VALUES(?,?,?,?,?)').run(run.id, task.id, device, run.version, run.expires);
      this.db.prepare('INSERT INTO run_deadline VALUES(?,?)').run(run.id, now + limitMs);
      this.db.prepare('INSERT INTO run_activity(run_id,last_output) VALUES(?,?)').run(run.id, now);
      this.db.prepare("UPDATE task SET status='running' WHERE id=?").run(task.id);
      const predecessors = this.predecessorInputs(task.id);
      if (predecessors.length) {
        this.db.prepare(`INSERT INTO run_dependency(run_id,predecessor,version)
          SELECT ?,p.id,p.version FROM workflow_dependency d JOIN task p ON p.id=d.predecessor
          WHERE d.task_id=?`).run(run.id, task.id);
      }
      const queued = this.db.prepare('DELETE FROM task_queue_time WHERE task_id=? RETURNING enqueued_at').get(task.id);
      const queueWaitMs = queued ? Math.max(0, now - Number(queued.enqueued_at)) : undefined;
      if (queueWaitMs !== undefined) {
        const limit = queueLatencyBounds.findIndex(bound => queueWaitMs <= bound);
        const bucket = limit < 0 ? queueLatencyBounds.length : limit;
        this.db.prepare(`INSERT INTO task_queue_latency VALUES(?,?,1,?) ON CONFLICT(owner,bucket)
          DO UPDATE SET count=count+1,total_ms=total_ms+excluded.total_ms`).run(owner, bucket, queueWaitMs);
      }
      this.event(task.id, 'run.started', {
        runId: run.id, ...(queueWaitMs !== undefined && { queueWaitMs }), ...(worker && { worker }), predecessors: predecessors.map(({ taskId, version, artifact }) => ({
          taskId, version, ...(artifact && { artifactId: artifact.id }),
        })),
      });
      this.dispatch.markDispatched(owner, workspace, goalPrefix, excludingPrefix, task.origin_channel, this.eventCursor());
      const assignment = this.assignment(owner, run, predecessors);
      if (resolvedGoal) assignment.task = { ...assignment.task, goal: resolvedGoal };
      if (requestId) this.dispatch.saveReceipt(device, requestId, fingerprint, JSON.stringify(assignment), now);
      return { ...assignment, replayed: false };
    });
  }

  private workflowDesktopAction(taskId: string) {
    const row = this.db.prepare(`SELECT json_extract(data,'$.action') AS action FROM event
      WHERE taskId=? AND type='task.created' ORDER BY seq LIMIT 1`).get(taskId);
    return typeof row?.action === 'string' ? JSON.parse(row.action) as WorkflowAction : undefined;
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
    const memoryInputs = this.db.prepare(`SELECT memory_id AS id,version,'' AS body FROM task_memory_input WHERE task_id=? ORDER BY position`)
      .all(run.taskId) as unknown as TaskMemoryInput[];
    const attachments = this.db.prepare('SELECT name,text FROM task_attachment WHERE task_id=? ORDER BY position')
      .all(run.taskId) as unknown as TaskAttachment[];
    const task = this.get(owner, run.taskId)!;
    const expected = task.goal.startsWith('/click ') ? this.db.prepare(`SELECT json_extract(data,'$.action.expectedText') AS text
      FROM event WHERE taskId=? AND type='task.created' ORDER BY seq LIMIT 1`).get(run.taskId)?.text : undefined;
    const required = this.db.prepare('SELECT capability FROM task_worker_capability WHERE task_id=?').get(run.taskId)?.capability;
    return { run, task, instructions, predecessors, acceptanceCriteria,
      ...(required === 'full-input-artifacts' && { fullInputRequired: true }),
      ...(required === 'read-only' && { readOnlyRequired: true }),
      ...(typeof expected === 'string' && { clickExpectedText: expected }),
      ...(attachments.length && { attachments }),
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
      this.db.prepare('UPDATE run_activity SET last_output=?,stalled=0 WHERE run_id=?').run(now, runId);
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
          EXISTS(SELECT 1 FROM run_evidence_stop s WHERE s.run_id=r.id) OR
          EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id) OR (
          t.status='running' AND r.version<>t.version
          AND NOT EXISTS(SELECT 1 FROM run_steering s WHERE s.run_id=r.id)))`).get(owner, taskId) as
      { runId: string; device: string } | undefined;
  }

  deviceStopTargets(device: string) {
    return this.db.prepare(`SELECT r.id FROM run r JOIN task t ON t.id=r.taskId
      WHERE r.device=? AND (t.status IN ('pausing','cancelling') OR
          EXISTS(SELECT 1 FROM run_evidence_stop s WHERE s.run_id=r.id) OR
          EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id) OR (
          t.status='running' AND r.version<>t.version
          AND NOT EXISTS(SELECT 1 FROM run_steering s WHERE s.run_id=r.id)))
      UNION ALL SELECT run_id AS id FROM expired_approval_stop WHERE device_id=? AND expires>?`).all(device, device, Date.now());
  }

  acknowledgeStop(runId: string, device: string, now: number) {
    return this.transaction(() => {
      const run = this.db.prepare(`SELECT r.taskId,t.status,
        EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id) AS staleInputs
        FROM run r JOIN task t ON t.id=r.taskId
        WHERE r.id=? AND r.device=? AND r.expires>? AND (t.status IN ('pausing','cancelling') OR
          EXISTS(SELECT 1 FROM run_evidence_stop s WHERE s.run_id=r.id) OR
          EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id) OR (
          t.status='running' AND r.version<>t.version))`).get(runId, device, now);
      if (!run) {
        const pending = this.db.prepare('DELETE FROM expired_approval_stop WHERE run_id=? AND device_id=? RETURNING task_id')
          .get(runId, device);
        if (pending?.task_id) this.event(String(pending.task_id), 'run.stop_confirmed', { runId });
        return Boolean(pending);
      }
      const taskId = String(run.taskId);
      if (run.status === 'pausing' || run.status === 'cancelling') {
        this.finishStoppedRun(runId, taskId, run.status === 'pausing');
      } else if (this.runEvidenceStopping(runId)) {
        this.finishRejectedEvidence(runId, taskId);
      } else if (run.staleInputs) {
        this.finishInvalidInputs(runId, taskId);
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

  private requireDesktopReconciliation(taskId: string, runId: string) {
    this.db.prepare(`INSERT OR REPLACE INTO desktop_reconciliation VALUES(?,(
      SELECT json_group_array(json_array(predecessor,version)) FROM run_dependency WHERE run_id=?
    ))`).run(taskId, runId);
  }

  private clickMayHaveExecuted(taskId: string, runId: string) {
    return Boolean(this.db.prepare(`SELECT 1 FROM task t JOIN approval a ON a.taskId=t.id
      JOIN approval_use u ON u.id=a.id WHERE t.id=? AND a.runId=? AND substr(t.goal,1,7)='/click '`).get(taskId, runId));
  }

  private finishInvalidInputs(runId: string, taskId: string) {
    const click = this.clickMayHaveExecuted(taskId, runId);
    if (click) this.requireDesktopReconciliation(taskId, runId);
    this.db.prepare('DELETE FROM run WHERE id=?').run(runId);
    const message = click
      ? 'An upstream result changed after click approval. Check whether the click took effect.'
      : 'An upstream result changed during execution. Review the run before retrying.';
    this.db.prepare("UPDATE task SET status='waiting_user',result=? WHERE id=?").run(message, taskId);
    this.event(taskId, 'run.inputs_changed', { runId, status: 'waiting_user' });
  }

  private finishStoppedRun(runId: string, taskId: string, paused: boolean) {
    const clickMayHaveExecuted = this.clickMayHaveExecuted(taskId, runId);
    if (clickMayHaveExecuted && paused) this.requireDesktopReconciliation(taskId, runId);
    this.db.prepare('DELETE FROM run WHERE id=?').run(runId);
    if (clickMayHaveExecuted) {
      this.db.prepare('UPDATE task SET status=?,result=? WHERE id=?').run(paused ? 'waiting_user' : 'cancelled',
        'The click may have been applied. Check the application before retrying.', taskId);
    } else {
      this.db.prepare('UPDATE task SET status=? WHERE id=?').run(paused ? 'paused' : 'cancelled', taskId);
    }
    this.event(taskId, paused ? (clickMayHaveExecuted ? 'run.finished' : 'task.paused') : 'task.cancelled',
      { runId, ...(clickMayHaveExecuted && { reconciliationRequired: true }) });
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
      const click = String(row.goal).startsWith('/click ');
      if ((outcome.status === 'waiting_user' && !click) ||
          (click && outcome.status !== 'failed' && !this.db.prepare(`SELECT 1 FROM approval_use u
            JOIN approval a ON a.id=u.id WHERE a.runId=? AND a.version=?`).get(runId, row.runVersion!))) return false;
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
      if (row.staleInputs) {
        this.finishInvalidInputs(runId, taskId);
        return false;
      }
      if (outcome.status === 'waiting_user') this.requireDesktopReconciliation(taskId, runId);
      this.db.prepare('DELETE FROM run WHERE id=?').run(runId);
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
          LEFT JOIN device_worker worker ON worker.device_id=d.id
          LEFT JOIN workspace_worker_policy policy ON policy.owner=t.owner AND policy.workspace=t.workspace
          LEFT JOIN device_desktop_apps a ON a.device_id=d.id
          WHERE d.owner=t.owner AND d.workspace=t.workspace AND d.revoked=0 AND p.last_seen>=?
          AND NOT EXISTS(SELECT 1 FROM device_pause pause WHERE pause.device_id=d.id)
          AND NOT EXISTS(SELECT 1 FROM device_interruption i WHERE i.device_id=d.id)
          AND (p.capability IS NULL OR p.capability=CASE
            WHEN substr(t.goal,1,9)='/preview ' THEN 'document.preview'
            WHEN substr(t.goal,1,9)='/observe ' OR substr(t.goal,1,7)='/click ' THEN 'computer.observe'
            ELSE 'agent.acp' END)
          AND (policy.protocols IS NULL OR substr(t.goal,1,9) IN ('/observe ','/preview ') OR substr(t.goal,1,7)='/click '
            OR (p.capability='agent.acp' AND EXISTS(SELECT 1 FROM json_each(policy.protocols) WHERE value=worker.protocol)))
          AND (NOT EXISTS(SELECT 1 FROM task_worker_protocol wp WHERE wp.task_id=t.id) OR
            EXISTS(SELECT 1 FROM task_worker_protocol wp WHERE wp.task_id=t.id AND wp.protocol=worker.protocol))
          AND NOT EXISTS(SELECT 1 FROM task_worker_capability wc WHERE wc.task_id=t.id
            AND NOT EXISTS(SELECT 1 FROM json_each(worker.capabilities) WHERE value=wc.capability))
          AND (p.capability='agent.acp' OR (
            NOT EXISTS(SELECT 1 FROM task_app_evidence e WHERE e.task_id=t.id)
            AND NOT EXISTS(SELECT 1 FROM task_memory_input m WHERE m.task_id=t.id)
            AND NOT EXISTS(SELECT 1 FROM task_attachment a WHERE a.task_id=t.id)))
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

  watchSilentRuns(now: number) {
    return this.transaction(() => {
      const silent = this.db.prepare(`UPDATE run_activity SET stalled=1 WHERE stalled=0 AND last_output<=?
        AND EXISTS(SELECT 1 FROM run r JOIN task t ON t.id=r.taskId
          WHERE r.id=run_activity.run_id AND r.expires>? AND r.version=t.version AND t.status='running'
          AND NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id))
        RETURNING run_id, last_output`).all(now - runSilenceMs, now);
      for (const run of silent) {
        const runId = String(run.run_id);
        const task = this.db.prepare('SELECT taskId FROM run WHERE id=?').get(runId)!;
        this.event(String(task.taskId), 'run.stalled', { runId, lastOutput: Number(run.last_output) });
      }
      return silent.length;
    });
  }

  expire(now: number, notifyStop?: (device: string, runId: string) => void) {
    const stopped = this.transaction(() => {
      const expiredStops = this.db.prepare('DELETE FROM expired_approval_stop WHERE expires<=? RETURNING task_id,run_id').all(now);
      for (const stop of expiredStops) {
        if (stop.task_id) this.event(String(stop.task_id), 'run.stop_window_expired', { runId: stop.run_id });
      }
      this.db.prepare('DELETE FROM device_claim WHERE expires<=?').run(now);
      this.db.prepare('DELETE FROM artifact WHERE id IN (SELECT artifact_id FROM artifact_image WHERE expires<=?)').run(now);
      const approvals = this.db.prepare(`SELECT a.id,a.runId,a.taskId,a.expires,r.device,r.expires AS leaseExpires FROM approval a
        JOIN run r ON r.id=a.runId JOIN task t ON t.id=a.taskId
        WHERE a.decision IS NULL AND a.expires<=? AND a.expires<r.expires
        AND t.status='waiting_user' AND a.version=r.version AND r.version=t.version
        AND NOT EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id)
        AND NOT EXISTS(SELECT 1 FROM run_evidence_stop s WHERE s.run_id=r.id)`).all(now);
      for (const approval of approvals) {
        const taskId = String(approval.taskId);
        if (Number(approval.leaseExpires) > now) {
          this.db.prepare('INSERT INTO expired_approval_stop(run_id,device_id,expires,task_id) VALUES(?,?,?,?)')
            .run(approval.runId!, approval.device!, approval.leaseExpires!, taskId);
        }
        this.db.prepare('DELETE FROM run WHERE id=?').run(approval.runId!);
        this.db.prepare("UPDATE task SET status='failed',result=? WHERE id=?")
          .run('Required approval expired before a decision was made.', taskId);
        this.event(taskId, 'approval.expired', {
          approvalId: approval.id, runId: approval.runId, expires: approval.expires, status: 'failed',
        });
      }
      const rows = this.db.prepare(`SELECT r.id,r.device,r.taskId,t.status,r.expires=d.deadline AS deadlineReached,
        substr(t.goal,1,7)='/click ' AND EXISTS(SELECT 1 FROM approval a
          JOIN approval_use u ON u.id=a.id WHERE a.runId=r.id) AS clickMayHaveExecuted,
        EXISTS(SELECT 1 FROM invalid_workflow_run i WHERE i.id=r.id) AS staleInputs FROM run r
        JOIN task t ON r.taskId=t.id JOIN run_deadline d ON d.run_id=r.id WHERE r.expires<=?`).all(now);
      for (const row of rows) {
        const taskId = String(row.taskId);
        if (row.status === 'waiting_user' && this.runEvidenceStopping(String(row.id))) {
          this.finishRejectedEvidence(String(row.id), taskId);
          continue;
        }
        if (row.status === 'running' && !row.staleInputs && !row.deadlineReached &&
            this.db.prepare(`UPDATE workflow_observation SET recovery_count=recovery_count+1
              WHERE task_id=? AND recovery_count=0`).run(taskId).changes) {
          this.db.prepare('DELETE FROM run WHERE id=?').run(row.id!);
          this.db.prepare("UPDATE task SET status='queued',version=version+1,result=NULL WHERE id=?").run(taskId);
          this.event(taskId, 'run.lease_expired', { runId: row.id, status: 'queued', automaticRetry: true });
          this.updateWorkflowReadiness(taskId);
          continue;
        }
        if (row.staleInputs && row.status !== 'cancelling') {
          this.finishInvalidInputs(String(row.id), taskId);
          continue;
        }
        const status = row.status === 'cancelling' ? 'cancelled' : 'waiting_user';
        if (status === 'waiting_user' && row.clickMayHaveExecuted) this.requireDesktopReconciliation(taskId, String(row.id));
        this.db.prepare('DELETE FROM run WHERE id=?').run(row.id!);
        this.db.prepare('UPDATE task SET status=? WHERE id=?').run(status, taskId);
        const timedOut = status === 'waiting_user' && Boolean(row.deadlineReached);
        if (status === 'waiting_user' && row.clickMayHaveExecuted) {
          this.db.prepare('UPDATE task SET result=? WHERE id=?')
            .run('The click may have been applied. Check the application before retrying.', taskId);
        } else if (timedOut) this.db.prepare('UPDATE task SET result=? WHERE id=?')
          .run('The run reached its time limit. Review the device before retrying.', taskId);
        const event = timedOut ? 'run.deadline_exceeded' : 'run.lease_expired';
        this.event(taskId, event, { runId: row.id, status });
      }
      return [
        ...approvals.map(row => ({ device: String(row.device), runId: String(row.runId) })),
        ...rows.map(row => ({ device: String(row.device), runId: String(row.id) })),
      ];
    });
    if (notifyStop) for (const { device, runId } of stopped) notifyStop(device, runId);
    return stopped.length;
  }
}
