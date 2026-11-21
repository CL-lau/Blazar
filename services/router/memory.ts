import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export interface ResourceRef {
  connection: string;
  resource: string;
  revision: string;
}

const memoryWords = new Intl.Segmenter(undefined, { granularity: 'word' });
const eastAsianWord = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

type DocumentSyncLease = {
  owner: string; connection: string; workspace: string; cursor: string; token: string;
};

export class MemoryStore {
  private db: DatabaseSync;
  private fullText: boolean;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS app_connection (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, app TEXT NOT NULL,
        account TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, workspace TEXT
      );
      CREATE TABLE IF NOT EXISTS revoked_resource (
        connection TEXT NOT NULL REFERENCES app_connection(id), resource TEXT NOT NULL,
        PRIMARY KEY(connection,resource)
      );
      CREATE TABLE IF NOT EXISTS document_access (
        connection TEXT NOT NULL REFERENCES app_connection(id), resource TEXT NOT NULL,
        allowed INTEGER NOT NULL, request_id INTEGER NOT NULL, PRIMARY KEY(connection,resource)
      );
      CREATE TABLE IF NOT EXISTS app_usage (
        id INTEGER PRIMARY KEY, connection TEXT NOT NULL REFERENCES app_connection(id),
        workspace TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL, started INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS app_usage_connection ON app_usage(connection,id);
      CREATE INDEX IF NOT EXISTS app_usage_document_test ON app_usage(connection,id)
        WHERE operation='test' AND status<>'started';
      CREATE TABLE IF NOT EXISTS worker_app_usage (
        connection TEXT NOT NULL REFERENCES app_connection(id), run_id TEXT NOT NULL,
        task_id TEXT NOT NULL, workspace TEXT NOT NULL, started INTEGER NOT NULL,
        PRIMARY KEY(connection,run_id)
      );
      CREATE INDEX IF NOT EXISTS worker_app_usage_recent ON worker_app_usage(connection,started DESC);
      CREATE TABLE IF NOT EXISTS document_sync (
        connection TEXT NOT NULL REFERENCES app_connection(id), workspace TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL, due INTEGER NOT NULL, cursor TEXT NOT NULL DEFAULT '',
        lease_token TEXT, lease_expires INTEGER, PRIMARY KEY(connection,workspace)
      );
      CREATE INDEX IF NOT EXISTS document_sync_due ON document_sync(due);
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace TEXT NOT NULL,
        body TEXT NOT NULL, connection TEXT REFERENCES app_connection(id),
        resource TEXT, revision TEXT, created INTEGER NOT NULL, expires INTEGER
      );
      CREATE TABLE IF NOT EXISTS memory_state (
        id TEXT PRIMARY KEY REFERENCES memory(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, pinned INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memory_revision (
        id TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, body TEXT NOT NULL, changed INTEGER NOT NULL,
        PRIMARY KEY(id,version)
      );
      CREATE TABLE IF NOT EXISTS document_import (
        id TEXT PRIMARY KEY REFERENCES memory(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS memory_task_origin (
        id TEXT PRIMARY KEY REFERENCES memory(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL, task_version INTEGER NOT NULL, UNIQUE(task_id,task_version)
      );
      CREATE TABLE IF NOT EXISTS document_head (
        owner TEXT NOT NULL, workspace TEXT NOT NULL, connection TEXT NOT NULL REFERENCES app_connection(id),
        resource TEXT NOT NULL, memory_id TEXT NOT NULL, request_id INTEGER,
        PRIMARY KEY(owner,workspace,connection,resource)
      );
      CREATE INDEX IF NOT EXISTS memory_scope ON memory(owner,workspace,created);
      CREATE INDEX IF NOT EXISTS memory_connection ON memory(connection);
      CREATE INDEX IF NOT EXISTS memory_expiry ON memory(expires) WHERE expires IS NOT NULL;
    `);
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('memory_state') WHERE name='disabled'").get()) {
      this.db.exec('ALTER TABLE memory_state ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
    }
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('app_connection') WHERE name='workspace'").get()) {
      this.db.exec('ALTER TABLE app_connection ADD COLUMN workspace TEXT');
    }
    const option = this.db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get();
    this.fullText = option?.enabled === 1;
    const dropTriggers = `
      DROP TRIGGER IF EXISTS memory_insert;
      DROP TRIGGER IF EXISTS memory_delete;
      DROP TRIGGER IF EXISTS memory_update;
      DROP TRIGGER IF EXISTS memory_connection_scope;
      DROP TRIGGER IF EXISTS memory_document_access_insert;
      DROP TRIGGER IF EXISTS memory_document_access_update;
    `;
    if (!this.fullText) {
      this.db.exec(dropTriggers);
      return;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const initialized = this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_document_access_update'").get();
      if (!initialized) {
        this.db.exec(dropTriggers);
        this.db.exec('DROP TABLE IF EXISTS memory_search');
        this.db.exec('DROP VIEW IF EXISTS memory_indexable');
      }
      this.db.exec(`
        CREATE VIEW IF NOT EXISTS memory_connection_visible AS
          SELECT m.rowid,m.body,m.connection,m.resource FROM memory m LEFT JOIN app_connection a ON a.id=m.connection
          WHERE m.connection IS NULL OR (
            a.owner=m.owner AND a.active=1 AND (a.workspace IS NULL OR a.workspace=m.workspace)
          );
        CREATE VIEW IF NOT EXISTS memory_indexable AS
          SELECT m.rowid,m.body FROM memory_connection_visible m
          WHERE NOT EXISTS(SELECT 1 FROM document_access x WHERE x.connection=m.connection AND x.resource=m.resource AND x.allowed=0);
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(
          body, content='memory_indexable', content_rowid='rowid', tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS memory_insert AFTER INSERT ON memory
        WHEN EXISTS(SELECT 1 FROM memory_indexable WHERE rowid=new.rowid) BEGIN
          INSERT INTO memory_search(rowid,body) VALUES(new.rowid,new.body);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_update AFTER UPDATE OF body ON memory
        WHEN EXISTS(SELECT 1 FROM memory_indexable WHERE rowid=new.rowid) BEGIN
          INSERT INTO memory_search(memory_search,rowid,body) VALUES('delete',old.rowid,old.body);
          INSERT INTO memory_search(rowid,body) VALUES(new.rowid,new.body);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_delete BEFORE DELETE ON memory
        WHEN EXISTS(SELECT 1 FROM memory_indexable WHERE rowid=old.rowid) BEGIN
          INSERT INTO memory_search(memory_search,rowid,body) VALUES('delete',old.rowid,old.body);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_connection_scope AFTER UPDATE OF active,workspace ON app_connection BEGIN
          INSERT INTO memory_search(memory_search,rowid,body)
            SELECT 'delete',m.rowid,m.body FROM memory m WHERE m.connection=old.id AND m.owner=old.owner
              AND old.active=1 AND (old.workspace IS NULL OR old.workspace=m.workspace)
              AND NOT EXISTS(SELECT 1 FROM document_access x WHERE x.connection=m.connection AND x.resource=m.resource AND x.allowed=0)
              AND (new.active=0 OR (new.workspace IS NOT NULL AND new.workspace<>m.workspace));
          INSERT INTO memory_search(rowid,body)
            SELECT m.rowid,m.body FROM memory m WHERE m.connection=new.id AND m.owner=new.owner
              AND new.active=1 AND (new.workspace IS NULL OR new.workspace=m.workspace)
              AND NOT EXISTS(SELECT 1 FROM document_access x WHERE x.connection=m.connection AND x.resource=m.resource AND x.allowed=0)
              AND (old.active=0 OR (old.workspace IS NOT NULL AND old.workspace<>m.workspace));
        END;
        CREATE TRIGGER IF NOT EXISTS memory_document_access_insert AFTER INSERT ON document_access
        WHEN new.allowed=0 BEGIN
          INSERT INTO memory_search(memory_search,rowid,body)
            SELECT 'delete',m.rowid,m.body FROM memory_connection_visible m
              WHERE m.connection=new.connection AND m.resource=new.resource;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_document_access_update AFTER UPDATE OF allowed ON document_access
        WHEN old.allowed<>new.allowed BEGIN
          INSERT INTO memory_search(memory_search,rowid,body)
            SELECT 'delete',m.rowid,m.body FROM memory_connection_visible m
              WHERE new.allowed=0 AND m.connection=new.connection AND m.resource=new.resource;
          INSERT INTO memory_search(rowid,body)
            SELECT m.rowid,m.body FROM memory_connection_visible m
              WHERE new.allowed=1 AND m.connection=new.connection AND m.resource=new.resource;
        END;
      `);
      if (!initialized) this.db.exec("INSERT INTO memory_search(memory_search) VALUES('rebuild')");
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
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
      u.status AS test_status,u.started AS test_started,u.workspace AS test_workspace
      FROM app_connection a LEFT JOIN app_usage u ON u.id=(
        SELECT test.id FROM app_usage test WHERE test.connection=a.id AND test.operation='test'
        AND test.status<>'started' AND (a.workspace IS NULL OR test.workspace=a.workspace)
        ORDER BY test.id DESC LIMIT 1
      ) WHERE a.owner=? ORDER BY a.rowid DESC`).all(owner);
    return rows.map(({ id, app, account, active, workspace, test_status, test_started, test_workspace }) => ({
      id: String(id), app: String(app), account: String(account), active: Number(active),
      workspace: workspace === null ? null : String(workspace),
      ...(test_status !== null && { lastDocumentTest: {
        status: String(test_status), started: Number(test_started), workspace: String(test_workspace),
      } }),
    }));
  }

  connection(owner: string, id: string, workspace?: string) {
    return this.db.prepare(`SELECT app,account FROM app_connection WHERE owner=? AND id=? AND active=1
      AND (? IS NULL OR workspace IS NULL OR workspace=?)`)
      .get(owner, id, workspace ?? null, workspace ?? null) as { app: string; account: string } | undefined;
  }

  startAppUsage(connection: string, workspace: string, operation: 'import' | 'test' | 'refresh') {
    return this.db.prepare("INSERT INTO app_usage(connection,workspace,operation,status,started) VALUES(?,?,?,'started',?)")
      .run(connection, workspace, operation, Date.now()).lastInsertRowid;
  }

  finishAppUsage(id: number | bigint, status: 'succeeded' | 'failed' | 'access_changed' | 'access_denied') {
    this.db.prepare('UPDATE app_usage SET status=? WHERE id=?').run(status, id);
  }

  recordWorkerAppUsage(workspace: string, taskId: string, runId: string, connections: string[]) {
    this.db.prepare(`INSERT OR IGNORE INTO worker_app_usage
      SELECT value,?,?,?,? FROM json_each(?)`)
      .run(runId, taskId, workspace, Date.now(), JSON.stringify(connections));
  }

  appUsage(owner: string, connection: string) {
    if (!this.db.prepare('SELECT 1 FROM app_connection WHERE owner=? AND id=?').get(owner, connection)) return undefined;
    return this.db.prepare(`SELECT * FROM (
      SELECT id,workspace,operation,status,started,NULL AS taskId FROM app_usage WHERE connection=?
      UNION ALL
      SELECT run_id,workspace,'worker_memory','authorized',started,task_id FROM worker_app_usage WHERE connection=?
    ) ORDER BY started DESC,id DESC LIMIT 50`).all(connection, connection);
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
      lease_token=NULL,lease_expires=NULL WHERE connection=? AND workspace=? AND lease_token=?`)
      .run(next ?? '', now, next, sync.connection, sync.workspace, sync.token);
  }

  recordDocumentAccess(connection: string, resource: string, requestId: number | bigint, allowed: boolean) {
    this.db.prepare(`INSERT INTO document_access VALUES(?,?,?,?) ON CONFLICT(connection,resource) DO UPDATE
      SET allowed=excluded.allowed,request_id=excluded.request_id WHERE excluded.request_id>=document_access.request_id`)
      .run(connection, resource, Number(allowed), requestId);
  }

  importDocument(owner: string, workspace: string, body: string, source: ResourceRef,
                 requestId?: number | bigint): string | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let id: string | undefined;
      const available = this.connection(owner, source.connection, workspace) && !this.resourceRevoked(source.connection, source.resource);
      if (available && requestId !== undefined) this.recordDocumentAccess(source.connection, source.resource, requestId, true);
      if (available && !this.documentAccessDenied(source.connection, source.resource)) {
        const identical = this.db.prepare(`SELECT id FROM memory WHERE owner=? AND workspace=?
          AND connection=? AND resource=? AND revision=? AND expires IS NULL
          AND (body=? OR EXISTS(SELECT 1 FROM memory_revision r WHERE r.id=memory.id AND r.body=?))
          LIMIT 1`)
          .get(owner, workspace, source.connection, source.resource, source.revision, body, body);
        if (identical) id = String(identical.id);
        else id = this.remember(owner, workspace, body, source);
        if (id) {
          this.db.prepare('INSERT OR IGNORE INTO document_import VALUES(?)').run(id);
          this.db.prepare(`INSERT INTO document_head(owner,workspace,connection,resource,memory_id,request_id)
            VALUES(?,?,?,?,?,?) ON CONFLICT(owner,workspace,connection,resource) DO UPDATE
            SET memory_id=excluded.memory_id,request_id=excluded.request_id
            WHERE document_head.request_id IS NULL OR excluded.request_id IS NULL
              OR excluded.request_id>=document_head.request_id`)
            .run(owner, workspace, source.connection, source.resource, id, requestId ?? null);
        }
      }
      this.db.exec('COMMIT');
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  disconnect(owner: string, connection: string): boolean {
    return this.db.prepare('UPDATE app_connection SET active=0 WHERE id=? AND owner=? AND active=1')
      .run(connection, owner).changes === 1;
  }

  setConnectionWorkspace(owner: string, connection: string, workspace: string | null): boolean {
    return this.db.prepare('UPDATE app_connection SET workspace=? WHERE id=? AND owner=? AND active=1')
      .run(workspace, connection, owner).changes === 1;
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

  rememberTaskResult(owner: string, workspace: string, taskId: string, version: number, body: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare(`SELECT m.id FROM memory_task_origin o JOIN memory m ON m.id=o.id
        WHERE m.owner=? AND o.task_id=? AND o.task_version=?`).get(owner, taskId, version);
      const id = existing ? String(existing.id) : this.remember(owner, workspace, body)!;
      if (!existing) this.db.prepare('INSERT INTO memory_task_origin VALUES(?,?,?)').run(id, taskId, version);
      this.db.exec('COMMIT');
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recall(owner: string, workspace: string, query: string, allowedSources: readonly string[],
         disabled = false, includePersonal = true) {
    const term = query.trim();
    if (!term || term.length > 256) return [];
    const allowed = JSON.stringify(allowedSources);
    const filter = `m.owner=? AND m.workspace=? AND COALESCE(s.disabled,0)=? AND (m.expires IS NULL OR m.expires>?)
      AND NOT EXISTS(SELECT 1 FROM document_access x WHERE x.connection=m.connection AND x.resource=m.resource AND x.allowed=0)
      AND (NOT EXISTS(SELECT 1 FROM document_import i WHERE i.id=m.id) OR EXISTS (
        SELECT 1 FROM document_head h WHERE h.owner=m.owner AND h.workspace=m.workspace
          AND h.connection=m.connection AND h.resource=m.resource AND h.memory_id=m.id
      ))
      AND ((?=1 AND m.connection IS NULL) OR EXISTS (
        SELECT 1 FROM app_connection a WHERE a.id=m.connection AND a.owner=m.owner AND a.active=1 AND (a.workspace IS NULL OR a.workspace=m.workspace)
        AND a.id IN (SELECT value FROM json_each(?))
      ))`;
    const fields = `m.id,m.body,m.connection,m.resource,m.revision,m.created,m.expires,o.task_id AS taskId,o.task_version AS taskVersion,
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

  resolveAppEvidence(owner: string, workspace: string, references: { id: string; version: number }[]) {
    const rows = this.db.prepare(`SELECT m.id,m.connection,substr(m.body,1,1200) AS body,COALESCE(s.version,1) AS version
      FROM memory m JOIN app_connection a ON a.id=m.connection AND a.owner=m.owner
      LEFT JOIN memory_state s ON s.id=m.id
      JOIN json_each(?) ref ON json_extract(ref.value,'$.id')=m.id
        AND json_extract(ref.value,'$.version')=COALESCE(s.version,1)
      WHERE m.owner=? AND m.workspace=? AND a.active=1 AND (a.workspace IS NULL OR a.workspace=m.workspace)
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
    const sourceRevisions = item.connection === null ? [] : this.db.prepare(`SELECT m.id,m.revision,m.created,
      CASE WHEN h.memory_id=m.id THEN 1 ELSE 0 END AS current
      FROM memory m JOIN document_import i ON i.id=m.id
      LEFT JOIN document_head h ON h.owner=m.owner AND h.workspace=m.workspace AND h.connection=m.connection AND h.resource=m.resource
      WHERE m.owner=? AND m.workspace=? AND m.connection=? AND m.resource=? AND (m.expires IS NULL OR m.expires>?)
      ORDER BY m.created DESC,m.rowid DESC LIMIT 50`).all(owner, item.workspace!, item.connection!, item.resource!, now);
    return { item, edits, sourceRevisions };
  }

  revise(owner: string, id: string, expectedVersion: number, change: { body?: string; pinned?: boolean; disabled?: boolean }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
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
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let removed: number | undefined;
      if (this.connection(owner, connection)) {
        this.db.prepare('INSERT OR IGNORE INTO revoked_resource VALUES(?,?)').run(connection, resource);
        removed = this.removeResource(owner, connection, resource);
      }
      this.db.exec('COMMIT');
      return removed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  removeResource(owner: string, connection: string, resource: string): number {
    const result = this.db.prepare('DELETE FROM memory WHERE owner=? AND connection=? AND resource=?')
      .run(owner, connection, resource);
    return Number(result.changes);
  }
}
