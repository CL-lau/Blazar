import { sqliteTransaction } from '../../../packages/storage/sqlite.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ApplicationAction } from '../../../packages/apps/actions.ts';

export const applicationWriteTimeoutMs = 10_000;

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

  history(owner: string, connection: string) {
    if (!this.db.prepare('SELECT 1 FROM app_connection WHERE owner=? AND id=?').get(owner, connection)) return undefined;
    return this.db.prepare(`SELECT w.id,w.workspace,w.capability,w.status,w.expires,r.resolution
      FROM app_write w LEFT JOIN app_write_reconciliation r ON r.proposal=w.id
      WHERE w.owner=? AND w.connection=? ORDER BY w.rowid DESC LIMIT 50`).all(owner, connection);
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
  share(owner: string, id: string, client: string | null, now = Date.now()) {
    if (client === null) {
      return this.db.prepare(`DELETE FROM app_write_mobile_grant WHERE proposal=?
        AND EXISTS(SELECT 1 FROM app_write w WHERE w.id=proposal AND w.owner=?)`).run(id, owner).changes === 1;
    }
    return this.db.prepare(`INSERT INTO app_write_mobile_grant(proposal,client)
      SELECT id,? FROM app_write WHERE owner=? AND id=? AND status='pending' AND expires>?
      ON CONFLICT(proposal) DO UPDATE SET client=excluded.client`).run(client, owner, id, now).changes === 1;
  }

  shared(owner: string, client: string, id?: string) {
    return this.db.prepare(`SELECT w.id,w.capability,w.workspace,w.status,w.expires
      FROM app_write_mobile_grant g JOIN app_write w ON w.id=g.proposal
      JOIN app_connection a ON a.id=w.connection AND a.owner=w.owner AND a.active=1 AND a.scope_version=w.scope_version
      WHERE w.owner=? AND g.client=? AND (? IS NULL OR w.id=?)
      ORDER BY w.rowid DESC LIMIT 50`).all(owner, client, id ?? null, id ?? null);
  }

  canCheck(owner: string, id: string, revision: string, backend: string, now = Date.now()) {
    return Boolean(this.db.prepare(`SELECT 1 FROM app_write w JOIN app_connection a ON a.id=w.connection
      WHERE w.owner=? AND w.id=? AND w.definition_revision=? AND w.backend=?
        AND (w.status='outcome_unknown' OR (w.status='dispatching' AND w.expires+?<=?))
        AND a.owner=w.owner AND a.active=1 AND a.scope_version=w.scope_version
        AND (a.workspace IS NULL OR a.workspace=w.workspace)`).get(owner, id, revision, backend, applicationWriteTimeoutMs, now));
  }

  leaseOutcomeCheck(candidates: readonly { revision: string; backend: string }[], now = Date.now()) {
    return sqliteTransaction(this.db, () => {
      const due = this.db.prepare(`SELECT w.id,w.owner,w.backend,w.definition_revision AS revision
        FROM app_write w JOIN app_connection a ON a.id=w.connection
        JOIN json_each(?) c ON json_extract(c.value,'$.revision')=w.definition_revision
          AND json_extract(c.value,'$.backend')=w.backend
        LEFT JOIN app_write_check_schedule s ON s.proposal=w.id
        LEFT JOIN app_write_reconciliation r ON r.proposal=w.id
        WHERE r.proposal IS NULL AND (s.next_check IS NULL OR s.next_check<=?)
          AND (w.status='outcome_unknown' OR (w.status='dispatching' AND w.expires+?<=?))
          AND a.owner=w.owner AND a.active=1 AND a.scope_version=w.scope_version
          AND (a.workspace IS NULL OR a.workspace=w.workspace)
        ORDER BY COALESCE(s.next_check,0),w.rowid LIMIT 1`)
        .get(JSON.stringify(candidates), now, applicationWriteTimeoutMs, now) as {
          id: string; owner: string; backend: string; revision: string;
        } | undefined;
      if (!due) return undefined;
      this.db.prepare(`INSERT INTO app_write_check_schedule VALUES(?,?)
        ON CONFLICT(proposal) DO UPDATE SET next_check=excluded.next_check`).run(due.id, now + 300_000);
      return due;
    });
  }

  reconciliation(owner: string, id: string) {
    return this.db.prepare(`SELECT r.resolution,r.evidence,r.checked_at AS checkedAt
      FROM app_write_reconciliation r JOIN app_write w ON w.id=r.proposal
      WHERE w.owner=? AND w.id=?`).get(owner, id) as {
        resolution: 'applied' | 'not_applied'; evidence: string; checkedAt: number;
      } | undefined;
  }

  reconcile(owner: string, id: string, resolution: 'applied' | 'not_applied', evidence: string, now = Date.now()) {
    // An interrupted process can leave a claim behind. Wait beyond the latest possible dispatch timeout.
    return this.db.prepare(`INSERT INTO app_write_reconciliation(proposal,resolution,evidence,checked_at)
      SELECT id,?,?,? FROM app_write WHERE owner=? AND id=?
        AND (status='outcome_unknown' OR (status='dispatching' AND expires+?<=?))
      ON CONFLICT(proposal) DO NOTHING`).run(resolution, evidence, now, owner, id, applicationWriteTimeoutMs, now).changes === 1;
  }
}
