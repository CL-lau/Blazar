import { DatabaseSync } from 'node:sqlite';
import { windowImageLifetimeMs, type RunOutcome } from '../../packages/protocol/task.ts';

export type SessionCheckpoint = { key: string; id: string; instructionCount: number };

export class DeviceLedger {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS active_execution (
        workspace TEXT PRIMARY KEY, run_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_result (
        scope TEXT NOT NULL, run_id TEXT NOT NULL, outcome TEXT NOT NULL, expires INTEGER,
        PRIMARY KEY(scope,run_id)
      );
      CREATE TABLE IF NOT EXISTS pending_session (
        scope TEXT NOT NULL, run_id TEXT NOT NULL, checkpoint TEXT NOT NULL,
        PRIMARY KEY(scope,run_id)
      );
      CREATE TABLE IF NOT EXISTS worker_session (
        key TEXT PRIMARY KEY, session_id TEXT NOT NULL, instruction_count INTEGER NOT NULL
      );
    `);
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('pending_result') WHERE name='expires'").get()) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (!this.db.prepare("SELECT 1 FROM pragma_table_info('pending_result') WHERE name='expires'").get()) {
          this.db.exec(`
            ALTER TABLE pending_result ADD COLUMN expires INTEGER;
            DELETE FROM pending_result WHERE json_extract(outcome,'$.artifact.mime')='image/png';
          `);
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        this.db.close();
        throw error;
      }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS pending_image_expiry ON pending_result(expires) WHERE expires IS NOT NULL');
    this.pruneImages(Date.now());
  }

  private pruneImages(now: number) {
    this.db.prepare('DELETE FROM pending_result WHERE expires<=?').run(now);
  }

  save(scope: string, runId: string, outcome: RunOutcome, now = Date.now()) {
    const expires = outcome.artifact?.mime === 'image/png' ? now + windowImageLifetimeMs : null;
    this.db.prepare('INSERT INTO pending_result(scope,run_id,outcome,expires) VALUES(?,?,?,?)')
      .run(scope, runId, JSON.stringify(outcome), expires);
  }

  begin(workspace: string, runId: string) {
    this.db.prepare('INSERT INTO active_execution(workspace,run_id) VALUES(?,?)').run(workspace, runId);
  }

  interrupted(workspace: string) {
    const row = this.db.prepare('SELECT run_id FROM active_execution WHERE workspace=?').get(workspace);
    return row ? String(row.run_id) : undefined;
  }

  clearExecution(workspace: string, runId: string) {
    return this.db.prepare('DELETE FROM active_execution WHERE workspace=? AND run_id=?')
      .run(workspace, runId).changes === 1;
  }

  complete(workspace: string, scope: string, runId: string, outcome: RunOutcome, checkpoint?: SessionCheckpoint) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.clearExecution(workspace, runId)) throw new Error('Execution record missing');
      this.save(scope, runId, outcome);
      if (checkpoint && outcome.status === 'succeeded' && !outcome.artifact?.mime) {
        this.db.prepare('INSERT INTO pending_session VALUES(?,?,?)').run(scope, runId, JSON.stringify(checkpoint));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  next(scope: string, now = Date.now()) {
    this.pruneImages(now);
    const row = this.db.prepare('SELECT run_id,outcome FROM pending_result WHERE scope=? ORDER BY rowid LIMIT 1')
      .get(scope);
    if (!row) return undefined;
    return { runId: String(row.run_id), outcome: JSON.parse(String(row.outcome)) as RunOutcome };
  }

  takeSession(key: string, instructionCount: number) {
    const row = this.db.prepare('DELETE FROM worker_session WHERE key=? RETURNING session_id,instruction_count').get(key);
    if (!row || Number(row.instruction_count) >= instructionCount) return undefined;
    return { id: String(row.session_id), instructionCount: Number(row.instruction_count) };
  }

  acknowledge(scope: string, runId: string, accepted = false) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pending = this.db.prepare('DELETE FROM pending_session WHERE scope=? AND run_id=? RETURNING checkpoint')
        .get(scope, runId);
      if (accepted && pending) {
        const { key, id, instructionCount } = JSON.parse(String(pending.checkpoint)) as SessionCheckpoint;
        this.db.prepare('INSERT OR REPLACE INTO worker_session VALUES(?,?,?)').run(key, id, instructionCount);
      }
      this.db.prepare('DELETE FROM pending_result WHERE scope=? AND run_id=?').run(scope, runId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}
