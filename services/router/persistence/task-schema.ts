import type { DatabaseSync } from 'node:sqlite';
import { sqliteTransaction } from '../../../packages/storage/sqlite.ts';

export function initializeTaskSchema(db: DatabaseSync, runLimitMs: number) {
  const hasQuestionWorkers = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='task_question_worker'").get();
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS task (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace TEXT NOT NULL,
      goal TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'queued', result TEXT
    );
    CREATE TABLE IF NOT EXISTS task_queue_time (
      task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE, enqueued_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS task_queue_on_create AFTER INSERT ON task WHEN NEW.status='queued'
      BEGIN
        INSERT INTO task_queue_time VALUES(NEW.id, CAST(unixepoch('subsec') * 1000 AS INTEGER));
      END;
    CREATE TRIGGER IF NOT EXISTS task_queue_on_transition AFTER UPDATE OF status ON task
      WHEN NEW.status='queued' AND OLD.status NOT IN ('queued','waiting_device')
      BEGIN
        INSERT INTO task_queue_time VALUES(NEW.id, CAST(unixepoch('subsec') * 1000 AS INTEGER))
          ON CONFLICT(task_id) DO UPDATE SET enqueued_at=excluded.enqueued_at;
      END;
    CREATE TABLE IF NOT EXISTS task_queue_latency (
      owner TEXT NOT NULL, bucket INTEGER NOT NULL, count INTEGER NOT NULL, total_ms INTEGER NOT NULL,
      PRIMARY KEY(owner,bucket)
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
    CREATE INDEX IF NOT EXISTS channel_notice_owner ON channel_notice_binding(owner,channel,chat,thread);
    CREATE TABLE IF NOT EXISTS weixin_reply_context (
      owner TEXT NOT NULL, channel TEXT NOT NULL, chat TEXT NOT NULL,
      token TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(owner,channel,chat)
    );
    CREATE INDEX IF NOT EXISTS weixin_reply_context_expiry ON weixin_reply_context(expires);
    CREATE TABLE IF NOT EXISTS channel_cancel_reply (
      task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
      channel TEXT NOT NULL, chat TEXT NOT NULL, thread TEXT NOT NULL, message_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_reply_window (
      channel TEXT NOT NULL, chat TEXT NOT NULL, message_id TEXT NOT NULL, expires INTEGER NOT NULL,
      PRIMARY KEY(channel,chat,message_id)
    );
    CREATE TABLE IF NOT EXISTS dingtalk_reply_secret (
      channel TEXT NOT NULL, chat TEXT NOT NULL, message_id TEXT NOT NULL, sealed TEXT NOT NULL, expires INTEGER NOT NULL,
      PRIMARY KEY(channel,chat,message_id)
    );
    CREATE INDEX IF NOT EXISTS dingtalk_reply_secret_expiry ON dingtalk_reply_secret(expires);
    CREATE TABLE IF NOT EXISTS channel_message (
      owner TEXT NOT NULL, channel TEXT NOT NULL, message TEXT NOT NULL,
      PRIMARY KEY(owner,channel,message)
    );
    CREATE TABLE IF NOT EXISTS workflow (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL, UNIQUE(owner,request_key)
    );
    CREATE TABLE IF NOT EXISTS workflow_source (
      workflow_id TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(workflow_id,task_id)
    );
    CREATE INDEX IF NOT EXISTS workflow_source_task ON workflow_source(task_id,workflow_id);
    CREATE VIEW IF NOT EXISTS stale_workflow_step AS
      SELECT step.task_id FROM workflow_step step WHERE EXISTS (
        SELECT 1 FROM workflow_source src LEFT JOIN task source ON source.id=src.task_id
        WHERE src.workflow_id=step.workflow_id AND
          (source.status IS NOT 'succeeded' OR source.version IS NOT src.version)
      );
    CREATE TABLE IF NOT EXISTS workflow_step (
      workflow_id TEXT NOT NULL REFERENCES workflow(id), step_key TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE REFERENCES task(id), PRIMARY KEY(workflow_id,step_key)
    );
    CREATE TABLE IF NOT EXISTS desktop_reconciliation (
      task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE, inputs TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_run_budget (
      task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE, seconds INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_worker_capability (
      task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE, capability TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_worker_protocol (
      task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE, protocol TEXT NOT NULL,
      PRIMARY KEY(task_id,protocol)
    );
    CREATE TABLE IF NOT EXISTS workflow_observation (
      task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
      recovery_count INTEGER NOT NULL DEFAULT 0
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
    CREATE TABLE IF NOT EXISTS workspace_worker_policy (
      owner TEXT NOT NULL, workspace TEXT NOT NULL, protocols TEXT NOT NULL, max_concurrent INTEGER,
      run_limit_seconds INTEGER, require_read_only INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,workspace)
    );
    CREATE TABLE IF NOT EXISTS device_worker (
      device_id TEXT PRIMARY KEY REFERENCES device(id), label TEXT NOT NULL, protocol TEXT NOT NULL,
      revision TEXT, adapter_version INTEGER
    );
    CREATE TABLE IF NOT EXISTS channel_attachment_intent (
      owner TEXT NOT NULL, channel TEXT NOT NULL, chat TEXT NOT NULL, sender TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES task(id), command_id TEXT NOT NULL, expires INTEGER NOT NULL,
      PRIMARY KEY(owner,channel,chat,sender)
    );
    CREATE TABLE IF NOT EXISTS channel_attachment_receipt (
      owner TEXT NOT NULL, channel TEXT NOT NULL, message TEXT NOT NULL, command_id TEXT NOT NULL,
      PRIMARY KEY(owner,channel,message)
    );
    CREATE TABLE IF NOT EXISTS task_attachment (
      task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY(task_id,position)
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
    CREATE TABLE IF NOT EXISTS run_activity (
      run_id TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
      last_output INTEGER NOT NULL, stalled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS expired_approval_stop (
      run_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires INTEGER NOT NULL, task_id TEXT REFERENCES task(id)
    );
    CREATE INDEX IF NOT EXISTS expired_approval_stop_device ON expired_approval_stop(device_id);
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
    DROP VIEW IF EXISTS invalid_workflow_run;
    CREATE VIEW invalid_workflow_run AS
      SELECT r.id FROM run r WHERE r.taskId IN (SELECT task_id FROM stale_workflow_step) OR EXISTS (
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
      owner TEXT NOT NULL, caller TEXT NOT NULL, key TEXT NOT NULL, request TEXT NOT NULL, decision TEXT NOT NULL,
      PRIMARY KEY(owner,caller,key)
    );
    CREATE TABLE IF NOT EXISTS routing_task_evidence (
      owner TEXT NOT NULL, caller TEXT NOT NULL, request_key TEXT NOT NULL, task_id TEXT NOT NULL, version INTEGER NOT NULL,
      PRIMARY KEY(owner,caller,request_key,task_id)
    );
    CREATE TABLE IF NOT EXISTS command_receipt (
      owner TEXT NOT NULL, caller TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
      response TEXT NOT NULL, PRIMARY KEY(owner,caller,key)
    );
    CREATE INDEX IF NOT EXISTS task_dispatch ON task(workspace,status);
    CREATE INDEX IF NOT EXISTS task_memory_watch ON task(status)
      WHERE status IN ('queued','waiting_device','waiting_dependency','waiting_review','running','waiting_user');
    CREATE INDEX IF NOT EXISTS event_task ON event(taskId,seq);
    CREATE INDEX IF NOT EXISTS event_run_recovery ON event(taskId,type)
      WHERE type IN ('run.lease_expired','run.deadline_exceeded','run.device_interrupted','run.device_revoked');
  `);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('workspace_worker_policy') WHERE name='max_concurrent'").get()) {
    db.exec('ALTER TABLE workspace_worker_policy ADD COLUMN max_concurrent INTEGER');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('workspace_worker_policy') WHERE name='run_limit_seconds'").get()) {
    db.exec('ALTER TABLE workspace_worker_policy ADD COLUMN run_limit_seconds INTEGER');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('workspace_worker_policy') WHERE name='require_read_only'").get()) {
    db.exec('ALTER TABLE workspace_worker_policy ADD COLUMN require_read_only INTEGER NOT NULL DEFAULT 0');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('routing_decision') WHERE name='caller'").get()) {
    sqliteTransaction(db, () => db.exec(`
      ALTER TABLE routing_decision RENAME TO routing_decision_legacy;
      CREATE TABLE routing_decision (
        owner TEXT NOT NULL, caller TEXT NOT NULL, key TEXT NOT NULL, request TEXT NOT NULL, decision TEXT NOT NULL,
        PRIMARY KEY(owner,caller,key)
      );
      INSERT INTO routing_decision SELECT owner,'admin',key,request,decision FROM routing_decision_legacy;
      DROP TABLE routing_decision_legacy;
    `));
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('command_receipt') WHERE name='caller'").get()) {
    sqliteTransaction(db, () => db.exec(`
      ALTER TABLE command_receipt RENAME TO command_receipt_legacy;
      CREATE TABLE command_receipt (
        owner TEXT NOT NULL, caller TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        response TEXT NOT NULL, PRIMARY KEY(owner,caller,key)
      );
      INSERT INTO command_receipt SELECT owner,'admin',key,fingerprint,response FROM command_receipt_legacy;
      DROP TABLE command_receipt_legacy;
    `));
  }
  db.exec("CREATE INDEX IF NOT EXISTS routing_workspace ON routing_decision(owner,caller,json_extract(request,'$[0]'))");
  if (!db.prepare("SELECT 1 FROM pragma_table_info('expired_approval_stop') WHERE name='task_id'").get()) {
    sqliteTransaction(db, () => db.exec(`
      ALTER TABLE expired_approval_stop ADD COLUMN task_id TEXT REFERENCES task(id);
      UPDATE expired_approval_stop SET task_id=(
        SELECT e.taskId FROM event e WHERE e.type='approval.expired'
        AND json_extract(e.data,'$.runId')=expired_approval_stop.run_id ORDER BY e.seq DESC LIMIT 1
      );
    `));
  }
  db.exec('CREATE INDEX IF NOT EXISTS expired_approval_stop_task ON expired_approval_stop(task_id,expires)');
  const workerColumns = new Set(db.prepare("SELECT name FROM pragma_table_info('device_worker')").all()
    .map(column => column.name));
  if (!workerColumns.has('capabilities')) db.exec("ALTER TABLE device_worker ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]'");
  if (!workerColumns.has('revision')) db.exec('ALTER TABLE device_worker ADD COLUMN revision TEXT');
  if (!workerColumns.has('adapter_version')) db.exec('ALTER TABLE device_worker ADD COLUMN adapter_version INTEGER');
  if (!hasQuestionWorkers) {
    sqliteTransaction(db, () => db.exec(`CREATE TABLE task_question_worker (
      task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL, revision TEXT NOT NULL
    );
    INSERT OR IGNORE INTO task_question_worker(task_id,device_id,revision)
      SELECT t.id,receipt.device,json_extract(start.data,'$.worker.revision')
      FROM task t JOIN event finished ON finished.seq=(
        SELECT seq FROM event WHERE taskId=t.id AND type='run.finished' ORDER BY seq DESC LIMIT 1
      )
      JOIN run_receipt receipt ON receipt.id=json_extract(finished.data,'$.runId')
      JOIN event start ON start.taskId=t.id AND start.type='run.started' AND json_extract(start.data,'$.runId')=receipt.id
      WHERE t.status IN ('queued','waiting_device','waiting_user','waiting_dependency','paused')
        AND json_extract(finished.data,'$.waitingReason')='worker_question'
        AND json_extract(start.data,'$.worker.protocol')='jsonl'
        AND typeof(json_extract(start.data,'$.worker.revision'))='text'`));
  }
  sqliteTransaction(db, () => {
    db.exec(`INSERT OR IGNORE INTO workflow_observation(task_id)
      SELECT s.task_id FROM workflow_step s JOIN task t ON t.id=s.task_id
      JOIN task_desktop_device target ON target.task_id=t.id WHERE substr(t.goal,1,9)='/observe '`);
    if (db.prepare('INSERT OR IGNORE INTO event_retention VALUES(1,0)').run().changes) {
      db.prepare(`INSERT OR IGNORE INTO progress_event_time
        SELECT seq,? FROM event WHERE type='run.progress'`).run(Date.now());
    }
    db.exec(`INSERT OR IGNORE INTO channel_notice_binding
      SELECT o.id,MIN(t.owner),o.channel,o.chat,o.message_id FROM channel_outbox o
      JOIN channel_thread t ON t.channel=o.channel AND t.chat=o.chat AND t.thread=o.message_id
      WHERE NOT EXISTS(SELECT 1 FROM channel_notice_binding b WHERE b.notice=o.id)
      GROUP BY o.id HAVING COUNT(*)=1`);
    db.prepare('INSERT OR IGNORE INTO run_deadline SELECT id,expires+? FROM run').run(runLimitMs);
    db.prepare("UPDATE task_memory_input SET body='' WHERE body<>''").run();
    db.prepare(`INSERT OR IGNORE INTO task_queue_time
      SELECT id,? FROM task WHERE status IN ('queued','waiting_device')`).run(Date.now());
    db.prepare('INSERT OR IGNORE INTO run_activity(run_id,last_output) SELECT id,? FROM run').run(Date.now());
  });
}
