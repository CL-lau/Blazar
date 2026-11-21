import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PushKind, PushResult } from '../../../packages/notifications/apns.ts';
import { sqliteTransaction } from '../../../packages/storage/sqlite.ts';

export class MobileRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  createPairing(owner: string, now: number) {
    return sqliteTransaction(this.db, () => {
      this.db.prepare('DELETE FROM mobile_pairing WHERE expires<=?').run(now);
      const code = randomBytes(24).toString('base64url');
      const hash = createHash('sha256').update(code).digest('hex');
      const expires = now + 5 * 60_000;
      this.db.prepare('INSERT INTO mobile_pairing VALUES(?,?,?)').run(hash, owner, expires);
      return { code, expires };
    });
  }

  redeemPairing(code: string, name: string, now: number) {
    return sqliteTransaction(this.db, () => {
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
    return sqliteTransaction(this.db, () => {
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
    return sqliteTransaction(this.db, () => {
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
    return sqliteTransaction(this.db, () => {
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

  queuePush(taskId: string, kind: PushKind, now: number, approvalId?: string) {
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
    return sqliteTransaction(this.db, () => {
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
}
