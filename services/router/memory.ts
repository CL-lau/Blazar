import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export interface ResourceRef {
  connection: string;
  resource: string;
  revision: string;
}

const memoryWords = new Intl.Segmenter(undefined, { granularity: 'word' });
const eastAsianWord = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

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
    `;
    if (!this.fullText) {
      this.db.exec(dropTriggers);
      return;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const initialized = this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_connection_scope'").get();
      if (!initialized) {
        this.db.exec(dropTriggers);
        this.db.exec('DROP TABLE IF EXISTS memory_search');
      }
      this.db.exec(`
        CREATE VIEW IF NOT EXISTS memory_indexable AS
          SELECT m.rowid,m.body FROM memory m LEFT JOIN app_connection a ON a.id=m.connection
          WHERE m.connection IS NULL OR (
            a.owner=m.owner AND a.active=1 AND (a.workspace IS NULL OR a.workspace=m.workspace)
          );
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
              AND (new.active=0 OR (new.workspace IS NOT NULL AND new.workspace<>m.workspace));
          INSERT INTO memory_search(rowid,body)
            SELECT m.rowid,m.body FROM memory m WHERE m.connection=new.id AND m.owner=new.owner
              AND new.active=1 AND (new.workspace IS NULL OR new.workspace=m.workspace)
              AND (old.active=0 OR (old.workspace IS NOT NULL AND old.workspace<>m.workspace));
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
    return this.db.prepare('SELECT id,app,account,active,workspace FROM app_connection WHERE owner=? ORDER BY rowid DESC')
      .all(owner) as { id: string; app: string; account: string; active: number; workspace: string | null }[];
  }

  connection(owner: string, id: string, workspace?: string) {
    return this.db.prepare(`SELECT app,account FROM app_connection WHERE owner=? AND id=? AND active=1
      AND (? IS NULL OR workspace IS NULL OR workspace=?)`)
      .get(owner, id, workspace ?? null, workspace ?? null) as { app: string; account: string } | undefined;
  }

  startAppUsage(connection: string, workspace: string, operation: 'import' | 'test') {
    return this.db.prepare("INSERT INTO app_usage(connection,workspace,operation,status,started) VALUES(?,?,?,'started',?)")
      .run(connection, workspace, operation, Date.now()).lastInsertRowid;
  }

  finishAppUsage(id: number | bigint, status: 'succeeded' | 'failed' | 'access_changed') {
    this.db.prepare('UPDATE app_usage SET status=? WHERE id=?').run(status, id);
  }

  appUsage(owner: string, connection: string) {
    if (!this.db.prepare('SELECT 1 FROM app_connection WHERE owner=? AND id=?').get(owner, connection)) return undefined;
    return this.db.prepare('SELECT id,workspace,operation,status,started FROM app_usage WHERE connection=? ORDER BY id DESC LIMIT 50')
      .all(connection);
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
    const fields = `m.id,m.body,m.connection,m.resource,m.revision,m.created,o.task_id AS taskId,o.task_version AS taskVersion,
      COALESCE(s.version,1) AS version,COALESCE(s.pinned,0) AS pinned,COALESCE(s.disabled,0) AS disabled`;
    const state = 'LEFT JOIN memory_state s ON s.id=m.id LEFT JOIN memory_task_origin o ON o.id=m.id';
    const values = [owner, workspace, Number(disabled), Date.now(), Number(includePersonal), allowed] as const;
    if (!this.fullText || Array.from(term).length < 3) {
      return this.db.prepare(`SELECT ${fields} FROM memory m ${state} WHERE ${filter}
        AND instr(lower(m.body),lower(?))>0 ORDER BY pinned DESC,m.created DESC,m.rowid DESC LIMIT 25`).all(...values, term);
    }
    const phrase = '"' + term.replaceAll('"', '""') + '"';
    return this.db.prepare(`SELECT ${fields} FROM memory_search JOIN memory m ON m.rowid=memory_search.rowid ${state}
      WHERE ${filter} AND memory_search MATCH ? ORDER BY pinned DESC,rank,m.created DESC,m.rowid DESC LIMIT 25`)
      .all(...values, phrase);
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
