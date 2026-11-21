import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ApplicationAction } from '../../../packages/apps/actions.ts';

type WriteStatus = 'pending' | 'dispatching' | 'succeeded' | 'unavailable' | 'denied' | 'outcome_unknown';
type WriteRow = {
  id: string;
  connection: string;
  workspace: string;
  capability: string;
  definitionRevision: string;
  input: string;
  expires: number;
  status: WriteStatus;
  backend: string | null;
};

export class AppWriteRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  propose(owner: string, workspace: string, action: Pick<ApplicationAction, 'connectionId' | 'capability' | 'input'>,
          definitionRevision: string, expires: number) {
    const id = randomUUID();
    const inserted = this.db.prepare(`INSERT INTO app_write
      (id,owner,connection,workspace,scope_version,capability,definition_revision,input,expires,status)
      SELECT ?,owner,id,?,scope_version,?,?,?,?,'pending' FROM app_connection
      WHERE id=? AND owner=? AND active=1 AND (workspace IS NULL OR workspace=?)`).run(
      id, workspace, action.capability, definitionRevision, JSON.stringify(action.input), expires,
      action.connectionId, owner, workspace,
    );
    return inserted.changes === 1 ? id : undefined;
  }

  get(owner: string, id: string) {
    const row = this.db.prepare(`SELECT id,connection,workspace,capability,definition_revision AS definitionRevision,
      input,expires,status,backend FROM app_write WHERE owner=? AND id=?`).get(owner, id) as WriteRow | undefined;
    return row && { ...row, input: JSON.parse(row.input) as ApplicationAction['input'] };
  }

  claim(owner: string, id: string, definitionRevision: string, now = Date.now()) {
    // Commit the claim before contacting an external system. A restarted Router never replays it.
    return this.db.prepare(`UPDATE app_write SET status='dispatching'
      WHERE owner=? AND id=? AND status='pending' AND definition_revision=? AND expires>? AND EXISTS(
        SELECT 1 FROM app_connection a WHERE a.id=app_write.connection AND a.owner=app_write.owner
          AND a.active=1 AND a.scope_version=app_write.scope_version AND (a.workspace IS NULL OR a.workspace=app_write.workspace)
      )`).run(owner, id, definitionRevision, now).changes === 1;
  }

  selectBackend(owner: string, id: string, backend: string) {
    return this.db.prepare(`UPDATE app_write SET backend=? WHERE owner=? AND id=? AND status='dispatching' AND EXISTS(
      SELECT 1 FROM app_connection a WHERE a.id=app_write.connection AND a.owner=app_write.owner
        AND a.active=1 AND a.scope_version=app_write.scope_version AND (a.workspace IS NULL OR a.workspace=app_write.workspace)
    )`).run(backend, owner, id).changes === 1;
  }

  finish(owner: string, id: string, status: Exclude<WriteStatus, 'pending' | 'dispatching'>) {
    return this.db.prepare("UPDATE app_write SET status=? WHERE owner=? AND id=? AND status='dispatching'")
      .run(status, owner, id).changes === 1;
  }
}
