import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { DocumentReadBackend } from '../../packages/apps/documents.ts';
import { sqliteTransaction } from '../../packages/storage/sqlite.ts';
import { AppWriteRepository } from './persistence/app-write-repository.ts';
import { initializeMemorySchema } from './persistence/memory-schema.ts';

export interface ResourceRef {
  connection: string;
  resource: string;
  revision: string;
}

export class DocumentRevisionConflict extends Error {}

const memoryWords = new Intl.Segmenter(undefined, { granularity: 'word' });
const eastAsianWord = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// A derived fact is current only while its entire evidence chain still matches.
const currentDerivation = `NOT EXISTS (
  WITH RECURSIVE evidence(id,version) AS (
    SELECT evidence_id,evidence_version FROM memory_derivation WHERE id=m.id
    UNION ALL
    SELECT d.evidence_id,d.evidence_version FROM evidence e JOIN memory_derivation d ON d.id=e.id
  )
  SELECT 1 FROM evidence e LEFT JOIN memory p ON p.id=e.id
  LEFT JOIN memory_state ps ON ps.id=p.id
  WHERE p.id IS NULL OR p.owner<>m.owner OR p.workspace<>m.workspace
    OR COALESCE(ps.version,1)<>e.version OR COALESCE(ps.disabled,0)<>0
    OR (p.expires IS NOT NULL AND p.expires<=unixepoch()*1000)
    OR (EXISTS(SELECT 1 FROM document_import i WHERE i.id=p.id)
      AND NOT EXISTS(SELECT 1 FROM document_head h WHERE h.memory_id=p.id))
)`;

type DocumentSyncLease = {
  owner: string; connection: string; workspace: string; cursor: string; token: string;
};

export class MemoryStore {
  private db: DatabaseSync;
  private fullText: boolean;
  readonly appWrites: AppWriteRepository;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.fullText = initializeMemorySchema(this.db);
      this.appWrites = new AppWriteRepository(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  connect(owner: string, app: string, account: string, workspace?: string): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO app_connection(id,owner,app,account,workspace) VALUES(?,?,?,?,?)')
      .run(id, owner, app, account, workspace ?? null);
    return id;
  }

  connections(owner: string) {
    const rows = this.db.prepare(`SELECT a.id,a.app,a.account,a.active,a.workspace,
      u.status AS test_status,u.started AS test_started,u.workspace AS test_workspace,
      h.status AS health_status,h.started AS health_started,h.workspace AS health_workspace
      FROM app_connection a LEFT JOIN app_usage u ON u.id=(
        SELECT test.id FROM app_usage test WHERE test.connection=a.id AND test.operation='test'
        AND test.status<>'started' AND (a.workspace IS NULL OR test.workspace=a.workspace)
        ORDER BY test.id DESC LIMIT 1
      ) LEFT JOIN app_usage h ON h.id=(
        SELECT health.id FROM app_usage health WHERE health.connection=a.id AND health.operation='health'
        AND health.status<>'started' AND health.scope_version=a.scope_version AND a.active=1
        ORDER BY health.id DESC LIMIT 1
      ) WHERE a.owner=? ORDER BY a.rowid DESC`).all(owner);
    return rows.map(({ id, app, account, active, workspace, test_status, test_started, test_workspace,
      health_status, health_started, health_workspace }) => ({
      id: String(id), app: String(app), account: String(account), active: Number(active),
      workspace: workspace === null ? null : String(workspace),
      ...(test_status !== null && { lastDocumentTest: {
        status: String(test_status), started: Number(test_started), workspace: String(test_workspace),
      } }),
      ...(health_status !== null && { lastHealthCheck: {
        status: String(health_status), started: Number(health_started), workspace: String(health_workspace),
      } }),
    }));
  }

  connection(owner: string, id: string, workspace?: string) {
    return this.db.prepare(`SELECT app,account,scope_version AS scopeVersion FROM app_connection WHERE owner=? AND id=? AND active=1
      AND (? IS NULL OR workspace IS NULL OR workspace=?)`)
      .get(owner, id, workspace ?? null, workspace ?? null) as { app: string; account: string; scopeVersion: number } | undefined;
  }

  startAppUsage(connection: string, workspace: string, operation: 'import' | 'test' | 'refresh' | 'search' | 'discover' | 'health' | 'read') {
    return this.db.prepare(`INSERT INTO app_usage(connection,workspace,operation,status,started,scope_version)
      VALUES(?,?,?,'started',?,(SELECT scope_version FROM app_connection WHERE id=?))`)
      .run(connection, workspace, operation, Date.now(), connection).lastInsertRowid;
  }

  finishAppUsage(id: number | bigint, status: 'succeeded' | 'failed' | 'access_changed' | 'access_denied' | 'source_conflict',
                 backend?: DocumentReadBackend) {
    this.db.prepare('UPDATE app_usage SET status=?,read_backend=? WHERE id=?')
      .run(status, backend ? JSON.stringify(backend) : null, id);
  }

  recordWorkerAppUsage(workspace: string, taskId: string, runId: string, connections: string[]) {
    this.db.prepare(`INSERT OR IGNORE INTO worker_app_usage
      SELECT value,?,?,?,? FROM json_each(?)`)
      .run(runId, taskId, workspace, Date.now(), JSON.stringify(connections));
  }

  appUsage(owner: string, connection: string) {
    if (!this.db.prepare('SELECT 1 FROM app_connection WHERE owner=? AND id=?').get(owner, connection)) return undefined;
    return this.db.prepare(`SELECT * FROM (
      SELECT id,workspace,operation,status,started,NULL AS taskId,read_backend FROM app_usage WHERE connection=?
      UNION ALL
      SELECT run_id,workspace,'worker_memory','authorized',started,task_id,NULL FROM worker_app_usage WHERE connection=?
    ) ORDER BY started DESC,id DESC LIMIT 50`).all(connection, connection)
      .map(({ read_backend, ...item }) => ({
        ...item, ...(typeof read_backend === 'string' && { backend: JSON.parse(read_backend) as DocumentReadBackend }),
      }));
  }

  documentsToRefresh(owner: string, workspace: string, connection: string, after: string) {
    return this.db.prepare(`SELECT h.resource FROM document_head h JOIN memory m ON m.id=h.memory_id
      WHERE h.owner=? AND h.workspace=? AND h.connection=? AND h.resource>?
      AND NOT EXISTS(SELECT 1 FROM revoked_resource r WHERE r.connection=h.connection AND r.resource=h.resource)
      ORDER BY h.resource LIMIT 9`).all(owner, workspace, connection, after).map(row => String(row.resource));
  }

  documentSyncSettings(owner: string) {
    return this.db.prepare(`SELECT s.connection,s.workspace,s.interval_minutes AS intervalMinutes
      FROM document_sync s JOIN app_connection a ON a.id=s.connection WHERE a.owner=? AND a.active=1
        AND (a.workspace IS NULL OR a.workspace=s.workspace) ORDER BY s.workspace`).all(owner);
  }

  setDocumentSync(owner: string, connection: string, workspace: string, interval: number | null, now = Date.now()) {
    if (!this.connection(owner, connection, workspace)) return false;
    if (interval === null) {
      this.db.prepare('DELETE FROM document_sync WHERE connection=? AND workspace=?').run(connection, workspace);
    } else {
      this.db.prepare(`INSERT INTO document_sync(connection,workspace,interval_minutes,due) VALUES(?,?,?,?)
        ON CONFLICT(connection,workspace) DO UPDATE SET interval_minutes=excluded.interval_minutes,
          due=excluded.due,cursor='',lease_token=NULL,lease_expires=NULL`).run(connection, workspace, interval, now);
    }
    return true;
  }

  leaseDocumentSync(now: number): DocumentSyncLease | undefined {
    const token = randomUUID();
    return this.db.prepare(`WITH candidate AS (
        SELECT s.rowid FROM document_sync s JOIN app_connection a ON a.id=s.connection
        WHERE a.active=1 AND (a.workspace IS NULL OR a.workspace=s.workspace) AND s.due<=?
          AND (s.lease_expires IS NULL OR s.lease_expires<=?) ORDER BY s.due,s.rowid LIMIT 1
      )
      UPDATE document_sync SET lease_token=?,lease_expires=? WHERE rowid=(SELECT rowid FROM candidate)
      RETURNING (SELECT owner FROM app_connection WHERE id=document_sync.connection) AS owner,
        connection,workspace,cursor,lease_token AS token`).get(now, now, token, now + 45_000) as DocumentSyncLease | undefined;
  }

  documentSyncActive(sync: DocumentSyncLease, now = Date.now()) {
    return Boolean(this.connection(sync.owner, sync.connection, sync.workspace) &&
      this.db.prepare('SELECT 1 FROM document_sync WHERE connection=? AND workspace=? AND lease_token=? AND lease_expires>?')
        .get(sync.connection, sync.workspace, sync.token, now));
  }

  finishDocumentSync(sync: DocumentSyncLease, next: string | null, now = Date.now()) {
    this.db.prepare(`UPDATE document_sync SET cursor=?,due=?+CASE WHEN ? IS NULL THEN interval_minutes*60000 ELSE 0 END,
      lease_token=NULL,lease_expires=NULL WHERE connection=? AND workspace=? AND lease_token=? AND lease_expires>?`)
      .run(next ?? '', now, next, sync.connection, sync.workspace, sync.token, now);
  }

  recordDocumentAccess(connection: string, resource: string, requestId: number | bigint, allowed: boolean) {
    this.db.prepare(`INSERT INTO document_access VALUES(?,?,?,?) ON CONFLICT(connection,resource) DO UPDATE
      SET allowed=excluded.allowed,request_id=excluded.request_id WHERE excluded.request_id>=document_access.request_id`)
      .run(connection, resource, Number(allowed), requestId);
  }

  hasNewerDocumentDenial(connection: string, resource: string, requestId: number | bigint) {
    return Boolean(this.db.prepare(`SELECT 1 FROM document_access
      WHERE connection=? AND resource=? AND allowed=0 AND request_id>?`).get(connection, resource, requestId));
  }

  importDocument(owner: string, workspace: string, body: string, source: ResourceRef,
                 requestId?: number | bigint, backend?: DocumentReadBackend): string | undefined {
    return sqliteTransaction(this.db, () => {
      let id: string | undefined;
      const available = this.connection(owner, source.connection, workspace) && !this.resourceRevoked(source.connection, source.resource);
      if (available && requestId !== undefined) this.recordDocumentAccess(source.connection, source.resource, requestId, true);
      if (available && !this.documentAccessDenied(source.connection, source.resource)) {
        if (backend?.fallback && this.db.prepare(`SELECT 1 FROM document_head h
          JOIN memory m ON m.id=h.memory_id
          WHERE h.owner=? AND h.workspace=? AND h.connection=? AND h.resource=?
          AND h.primary_verified=1 AND m.revision IS NOT ?`)
          .get(owner, workspace, source.connection, source.resource, source.revision)) {
          throw new DocumentRevisionConflict();
        }
        const identical = this.db.prepare(`SELECT id FROM memory WHERE owner=? AND workspace=?
          AND connection=? AND resource=? AND revision=? AND expires IS NULL
          AND (body=? OR EXISTS(SELECT 1 FROM memory_revision r WHERE r.id=memory.id AND r.body=?))
          LIMIT 1`)
          .get(owner, workspace, source.connection, source.resource, source.revision, body, body);
        if (identical) id = String(identical.id);
        else id = this.remember(owner, workspace, body, source);
        if (id) {
          this.db.prepare('INSERT OR IGNORE INTO document_import(id,read_backend) VALUES(?,?)')
            .run(id, backend ? JSON.stringify(backend) : null);
          this.db.prepare(`INSERT INTO document_head(owner,workspace,connection,resource,memory_id,request_id,primary_verified)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,workspace,connection,resource) DO UPDATE
            SET memory_id=excluded.memory_id,request_id=excluded.request_id,
              primary_verified=CASE WHEN memory_id=excluded.memory_id
                THEN max(primary_verified,excluded.primary_verified) ELSE excluded.primary_verified END
            WHERE document_head.request_id IS NULL OR excluded.request_id IS NULL
              OR excluded.request_id>=document_head.request_id`)
            .run(owner, workspace, source.connection, source.resource, id, requestId ?? null, Number(backend?.fallback === false));
        }
      }
      return id;
    });
  }

  disconnect(owner: string, connection: string): boolean {
    return this.db.prepare('UPDATE app_connection SET active=0 WHERE id=? AND owner=? AND active=1')
      .run(connection, owner).changes === 1;
  }

  setConnectionWorkspace(owner: string, connection: string, workspace: string | null): boolean {
    return this.db.prepare(`UPDATE app_connection SET scope_version=scope_version+CASE WHEN workspace IS ? THEN 0 ELSE 1 END, workspace=?
      WHERE id=? AND owner=? AND active=1`)
      .run(workspace, workspace, connection, owner).changes === 1;
  }

  remember(owner: string, workspace: string, body: string, source?: ResourceRef, expires?: number): string | undefined {
    const id = randomUUID();
    const inserted = this.db.prepare(`INSERT INTO memory(id,owner,workspace,body,connection,resource,revision,created,expires)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ? IS NULL OR EXISTS (
        SELECT 1 FROM app_connection a WHERE a.id=? AND a.owner=? AND a.active=1
        AND (a.workspace IS NULL OR a.workspace=?)
        AND NOT EXISTS(SELECT 1 FROM revoked_resource r WHERE r.connection=a.id AND r.resource=?)
        AND NOT EXISTS(SELECT 1 FROM document_access x WHERE x.connection=a.id AND x.resource=? AND x.allowed=0)
      )`).run(id, owner, workspace, body, source?.connection ?? null, source?.resource ?? null,
      source?.revision ?? null, Date.now(), expires ?? null, source?.connection ?? null,
      source?.connection ?? null, owner, workspace, source?.resource ?? null, source?.resource ?? null);
    return inserted.changes === 1 ? id : undefined;
  }

  rememberFromEvidence(owner: string, workspace: string, sourceId: string, version: number, body: string) {
    return sqliteTransaction(this.db, () => {
      if (!this.resolveAppEvidence(owner, workspace, [{ id: sourceId, version }])) return undefined;
      const source = this.db.prepare('SELECT connection,resource,revision,expires FROM memory WHERE id=?')
        .get(sourceId) as (ResourceRef & { expires: number | null }) | undefined;
      if (!source) return undefined;
      const prior = this.db.prepare(`SELECT m.id FROM memory m JOIN memory_derivation d ON d.id=m.id
        WHERE m.owner=? AND m.workspace=? AND d.evidence_id=? AND d.evidence_version=? AND m.body=?`)
        .get(owner, workspace, sourceId, version, body);
      if (prior) return String(prior.id);
      const id = this.remember(owner, workspace, body, source, source.expires ?? undefined);
      if (id) this.db.prepare('INSERT INTO memory_derivation VALUES(?,?,?)').run(id, sourceId, version);
      return id;
    });
  }

  rememberTaskResult(owner: string, workspace: string, taskId: string, version: number, body: string) {
    return sqliteTransaction(this.db, () => {
      const existing = this.db.prepare(`SELECT m.id FROM memory_task_origin o JOIN memory m ON m.id=o.id
        WHERE m.owner=? AND o.task_id=? AND o.task_version=?`).get(owner, taskId, version);
      const id = existing ? String(existing.id) : this.remember(owner, workspace, body)!;
      if (!existing) this.db.prepare('INSERT INTO memory_task_origin VALUES(?,?,?)').run(id, taskId, version);
      return id;
    });
  }

  recall(owner: string, workspace: string, query: string, allowedSources: readonly string[],
         disabled = false, includePersonal = true, options?: { documentsOnly?: boolean }) {
    const term = query.trim();
    if (!term || term.length > 256) return [];
    const allowed = JSON.stringify(allowedSources);
    const filter = `m.owner=? AND m.workspace=? AND COALESCE(s.disabled,0)=? AND (m.expires IS NULL OR m.expires>?)
      AND ${currentDerivation}
      ${options?.documentsOnly ? 'AND EXISTS(SELECT 1 FROM document_import i WHERE i.id=m.id)' : ''}
      AND NOT EXISTS(SELECT 1 FROM document_access x WHERE x.connection=m.connection AND x.resource=m.resource AND x.allowed=0)
      AND (NOT EXISTS(SELECT 1 FROM document_import i WHERE i.id=m.id) OR EXISTS (
        SELECT 1 FROM document_head h WHERE h.owner=m.owner AND h.workspace=m.workspace
          AND h.connection=m.connection AND h.resource=m.resource AND h.memory_id=m.id
      ))
      AND ((?=1 AND m.connection IS NULL) OR EXISTS (
        SELECT 1 FROM app_connection a WHERE a.id=m.connection AND a.owner=m.owner AND a.active=1 AND (a.workspace IS NULL OR a.workspace=m.workspace)
        AND a.id IN (SELECT value FROM json_each(?))
      ))`;
    const fields = `m.id,m.workspace,m.body,m.connection,m.resource,m.revision,m.created,m.expires,o.task_id AS taskId,o.task_version AS taskVersion,
      COALESCE(s.version,1) AS version,COALESCE(s.pinned,0) AS pinned,COALESCE(s.disabled,0) AS disabled`;
    const state = 'LEFT JOIN memory_state s ON s.id=m.id LEFT JOIN memory_task_origin o ON o.id=m.id';
    const values = [owner, workspace, Number(disabled), Date.now(), Number(includePersonal), allowed] as const;
    const length = (text: string) => Array.from(text).length;
    const quote = (text: string) => '"' + text.replaceAll('"', '""') + '"';
    const exact = !this.fullText || length(term) < 3
      ? this.db.prepare(`SELECT ${fields} FROM memory m ${state} WHERE ${filter}
          AND instr(lower(m.body),lower(?))>0 ORDER BY pinned DESC,m.created DESC,m.rowid DESC LIMIT 25`).all(...values, term)
      : this.db.prepare(`SELECT ${fields} FROM memory_search JOIN memory m ON m.rowid=memory_search.rowid ${state}
          WHERE ${filter} AND memory_search MATCH ? ORDER BY pinned DESC,rank,m.created DESC,m.rowid DESC LIMIT 25`)
        .all(...values, quote(term));
    if (exact.length) return exact;

    const terms = [...new Set(term.split(/\s+/u))];
    if (terms.length < 2 || terms.length > 8 || terms.some(part => length(part) < 2)) return exact;
    const indexed = this.fullText ? terms.filter(part => length(part) >= 3) : [];
    const scan = indexed.length ? terms.filter(part => length(part) < 3) : terms;
    const source = indexed.length ? 'memory_search JOIN memory m ON m.rowid=memory_search.rowid' : 'memory m';
    const match = indexed.length ? 'AND memory_search MATCH ?' : '';
    const order = indexed.length ? 'rank,' : '';
    return this.db.prepare(`SELECT ${fields} FROM ${source} ${state} WHERE ${filter} ${match}
      AND NOT EXISTS(SELECT 1 FROM json_each(?) word WHERE instr(lower(m.body),lower(word.value))=0)
      ORDER BY pinned DESC,${order}m.created DESC,m.rowid DESC LIMIT 25`)
      .all(...values, ...(indexed.length ? [indexed.map(quote).join(' AND ')] : []), JSON.stringify(scan));
  }

  personalContext(owner: string, workspace: string, text: string) {
    const terms = new Set<string>();
    for (const token of memoryWords.segment(text.toLowerCase())) {
      if (!token.isWordLike) continue;
      const length = Array.from(token.segment).length;
      if (length >= (eastAsianWord.test(token.segment) ? 2 : 3) && length <= 32) terms.add(token.segment);
      if (terms.size >= 12) break;
    }
    return this.db.prepare(`SELECT m.id,substr(m.body,1,1200) AS body,COALESCE(s.version,1) AS version
      FROM memory m LEFT JOIN memory_state s ON s.id=m.id
      WHERE m.owner=? AND m.workspace=? AND m.connection IS NULL AND COALESCE(s.disabled,0)=0
      AND (m.expires IS NULL OR m.expires>?) AND (s.pinned=1 OR EXISTS (
        SELECT 1 FROM json_each(?) term WHERE instr(lower(m.body),term.value)>0
      )) ORDER BY COALESCE(s.pinned,0) DESC,m.created DESC,m.rowid DESC LIMIT 4`)
      .all(owner, workspace, Date.now(), JSON.stringify([...terms]))
      .map(row => ({ id: String(row.id), body: String(row.body).toWellFormed(), version: Number(row.version) }));
  }

  resolvePersonalEvidence(owner: string, workspace: string, references: { id: string; version: number }[]) {
    const rows = this.db.prepare(`SELECT m.id,substr(m.body,1,1200) AS body,COALESCE(s.version,1) AS version
      FROM memory m LEFT JOIN memory_state s ON s.id=m.id
      JOIN json_each(?) ref ON json_extract(ref.value,'$.id')=m.id
        AND json_extract(ref.value,'$.version')=COALESCE(s.version,1)
      WHERE m.owner=? AND m.workspace=? AND m.connection IS NULL AND COALESCE(s.disabled,0)=0
        AND (m.expires IS NULL OR m.expires>?)
      ORDER BY CAST(ref.key AS INTEGER)`).all(JSON.stringify(references), owner, workspace, Date.now());
    if (rows.length !== references.length) return undefined;
    return rows.map(row => ({ id: String(row.id), body: String(row.body).toWellFormed(), version: Number(row.version) }));
  }

  resolveAppEvidence(owner: string, workspace: string, references: { id: string; version: number }[]) {
    const rows = this.db.prepare(`SELECT m.id,m.connection,substr(m.body,1,1200) AS body,COALESCE(s.version,1) AS version
      FROM memory m JOIN app_connection a ON a.id=m.connection AND a.owner=m.owner
      LEFT JOIN memory_state s ON s.id=m.id
      JOIN json_each(?) ref ON json_extract(ref.value,'$.id')=m.id
        AND json_extract(ref.value,'$.version')=COALESCE(s.version,1)
      WHERE m.owner=? AND m.workspace=? AND a.active=1 AND (a.workspace IS NULL OR a.workspace=m.workspace)
        AND ${currentDerivation}
        AND COALESCE(s.disabled,0)=0 AND (m.expires IS NULL OR m.expires>?)
        AND NOT EXISTS(SELECT 1 FROM revoked_resource r WHERE r.connection=m.connection AND r.resource=m.resource)
        AND NOT EXISTS(SELECT 1 FROM document_access x WHERE x.connection=m.connection AND x.resource=m.resource AND x.allowed=0)
        AND (NOT EXISTS(SELECT 1 FROM document_import i WHERE i.id=m.id) OR EXISTS(
          SELECT 1 FROM document_head h WHERE h.owner=m.owner AND h.workspace=m.workspace
            AND h.connection=m.connection AND h.resource=m.resource AND h.memory_id=m.id))
      ORDER BY CAST(ref.key AS INTEGER)`).all(JSON.stringify(references), owner, workspace, Date.now());
    if (rows.length !== references.length) return undefined;
    return rows.map(row => ({
      connection: String(row.connection), id: String(row.id), body: String(row.body).toWellFormed(), version: Number(row.version),
    }));
  }

  history(owner: string, id: string, now = Date.now()) {
    const item = this.db.prepare(`SELECT m.id,m.workspace,m.connection,m.resource,m.revision,m.created,
      COALESCE(s.version,1) AS version
      FROM memory m LEFT JOIN memory_state s ON s.id=m.id
      WHERE m.id=? AND m.owner=? AND (m.expires IS NULL OR m.expires>?)
      AND (m.connection IS NULL OR EXISTS(
        SELECT 1 FROM app_connection a WHERE a.id=m.connection AND a.owner=m.owner AND a.active=1
        AND (a.workspace IS NULL OR a.workspace=m.workspace)))
      AND NOT EXISTS(SELECT 1 FROM revoked_resource r WHERE r.connection=m.connection AND r.resource=m.resource)
      AND NOT EXISTS(SELECT 1 FROM document_access d WHERE d.connection=m.connection AND d.resource=m.resource AND d.allowed=0)`)
      .get(id, owner, now);
    if (!item) return undefined;
    const edits = this.db.prepare('SELECT version,changed AS replacedAt FROM memory_revision WHERE id=? ORDER BY version DESC LIMIT 50').all(id);
    const sourceRevisions = item.connection === null ? [] : this.db.prepare(`SELECT m.id,m.revision,m.created,i.read_backend,
      CASE WHEN h.memory_id=m.id THEN 1 ELSE 0 END AS current
      FROM memory m JOIN document_import i ON i.id=m.id
      LEFT JOIN document_head h ON h.owner=m.owner AND h.workspace=m.workspace AND h.connection=m.connection AND h.resource=m.resource
      WHERE m.owner=? AND m.workspace=? AND m.connection=? AND m.resource=? AND (m.expires IS NULL OR m.expires>?)
      ORDER BY m.created DESC,m.rowid DESC LIMIT 50`).all(owner, item.workspace!, item.connection!, item.resource!, now)
      .map(({ read_backend, ...entry }) => ({
        ...entry, ...(typeof read_backend === 'string' && { backend: JSON.parse(read_backend) as DocumentReadBackend }),
      }));
    const evidence = this.db.prepare('SELECT evidence_id AS id,evidence_version AS version FROM memory_derivation WHERE id=?').get(id);
    return { item, edits, sourceRevisions, ...(evidence && { derivedFrom: evidence }) };
  }

  revise(owner: string, id: string, expectedVersion: number, change: { body?: string; pinned?: boolean; disabled?: boolean }) {
    return sqliteTransaction(this.db, () => {
      const row = this.db.prepare(`SELECT m.body,COALESCE(s.version,1) AS version,COALESCE(s.pinned,0) AS pinned,COALESCE(s.disabled,0) AS disabled
        FROM memory m LEFT JOIN memory_state s ON s.id=m.id
        WHERE m.id=? AND m.owner=? AND (m.expires IS NULL OR m.expires>?)
        AND NOT EXISTS(SELECT 1 FROM document_access x WHERE x.connection=m.connection AND x.resource=m.resource AND x.allowed=0)
        AND (m.connection IS NULL OR EXISTS (
          SELECT 1 FROM app_connection a WHERE a.id=m.connection AND a.owner=m.owner AND a.active=1 AND (a.workspace IS NULL OR a.workspace=m.workspace)
        ))`).get(id, owner, Date.now());
      let result: { version: number; conflict: boolean } | undefined;
      if (row) {
        const version = Number(row.version);
        result = { version, conflict: version !== expectedVersion };
        if (!result.conflict) {
          const pinned = change.pinned === undefined ? Number(row.pinned) : Number(change.pinned);
          const disabled = change.disabled === undefined ? Number(row.disabled) : Number(change.disabled);
          const edited = change.body !== undefined && change.body !== row.body;
          if (edited) {
            this.db.prepare('INSERT INTO memory_revision VALUES(?,?,?,?)').run(id, version, row.body!, Date.now());
            this.db.prepare('UPDATE memory SET body=? WHERE id=?').run(change.body!, id);
          }
          if (edited || pinned !== row.pinned || disabled !== row.disabled) {
            result.version++;
            this.db.prepare(`INSERT INTO memory_state(id,version,pinned,disabled) VALUES(?,?,?,?) ON CONFLICT(id)
              DO UPDATE SET version=excluded.version,pinned=excluded.pinned,disabled=excluded.disabled`)
              .run(id, result.version, pinned, disabled);
          }
        }
      }
      return result;
    });
  }

  pruneExpired(now: number, limit: number) {
    return Number(this.db.prepare(`DELETE FROM memory WHERE rowid IN(
      SELECT rowid FROM memory WHERE expires IS NOT NULL AND expires<=? ORDER BY expires,rowid LIMIT ?
    )`).run(now, limit).changes);
  }

  remove(owner: string, id: string): boolean {
    return this.db.prepare('DELETE FROM memory WHERE id=? AND owner=?').run(id, owner).changes === 1;
  }

  resourceRevoked(connection: string, resource: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM revoked_resource WHERE connection=? AND resource=?')
      .get(connection, resource));
  }

  private documentAccessDenied(connection: string, resource: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM document_access WHERE connection=? AND resource=? AND allowed=0')
      .get(connection, resource));
  }

  revokeResource(owner: string, connection: string, resource: string) {
    return sqliteTransaction(this.db, () => {
      let removed: number | undefined;
      if (this.connection(owner, connection)) {
        this.db.prepare('INSERT OR IGNORE INTO revoked_resource VALUES(?,?)').run(connection, resource);
        removed = this.removeResource(owner, connection, resource);
      }
      return removed;
    });
  }

  removeResource(owner: string, connection: string, resource: string): number {
    const result = this.db.prepare('DELETE FROM memory WHERE owner=? AND connection=? AND resource=?')
      .run(owner, connection, resource);
    return Number(result.changes);
  }
}
