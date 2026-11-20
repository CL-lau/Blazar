import { DatabaseSync } from 'node:sqlite';
import type { RunOutcome } from '../../packages/protocol/task.ts';

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
        scope TEXT NOT NULL, run_id TEXT NOT NULL, outcome TEXT NOT NULL,
        PRIMARY KEY(scope,run_id)
      );
    `);
  }

  save(scope: string, runId: string, outcome: RunOutcome) {
    this.db.prepare('INSERT INTO pending_result VALUES(?,?,?)').run(scope, runId, JSON.stringify(outcome));
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

  complete(workspace: string, scope: string, runId: string, outcome: RunOutcome) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.clearExecution(workspace, runId)) throw new Error('Execution record missing');
      this.save(scope, runId, outcome);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  next(scope: string) {
    const row = this.db.prepare('SELECT run_id,outcome FROM pending_result WHERE scope=? ORDER BY rowid LIMIT 1')
      .get(scope);
    if (!row) return undefined;
    return { runId: String(row.run_id), outcome: JSON.parse(String(row.outcome)) as RunOutcome };
  }

  acknowledge(scope: string, runId: string) {
    this.db.prepare('DELETE FROM pending_result WHERE scope=? AND run_id=?').run(scope, runId);
  }

  close() {
    this.db.close();
  }
}
