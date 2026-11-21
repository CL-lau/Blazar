import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export interface ResourceRef {
  connection: string;
  resource: string;
  revision: string;
}

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
      CREATE INDEX IF NOT EXISTS memory_scope ON memory(owner,workspace,created);
    `);
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('memory_state') WHERE name='disabled'").get()) {
      this.db.exec('ALTER TABLE memory_state ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
    }
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('app_connection') WHERE name='workspace'").get()) {
      this.db.exec('ALTER TABLE app_connection ADD COLUMN workspace TEXT');
    }
    const option = this.db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get();
    this.fullText = option?.enabled === 1;
    if (!this.fullText) {
      this.db.exec('DROP TRIGGER IF EXISTS memory_insert; DROP TRIGGER IF EXISTS memory_delete; DROP TRIGGER IF EXISTS memory_update;');
      return;
    }
    const initialized = this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_insert'").get();
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(
        body, content='memory', content_rowid='rowid', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS memory_insert AFTER INSERT ON memory BEGIN
        INSERT INTO memory_search(rowid,body) VALUES(new.rowid,new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_update AFTER UPDATE OF body ON memory BEGIN
        INSERT INTO memory_search(memory_search,rowid,body) VALUES('delete',old.rowid,old.body);
        INSERT INTO memory_search(rowid,body) VALUES(new.rowid,new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_delete AFTER DELETE ON memory BEGIN
        INSERT INTO memory_search(memory_search,rowid,body) VALUES('delete',old.rowid,old.body);
      END;
    `);
    if (!initialized) this.db.exec("INSERT INTO memory_search(memory_search) VALUES('rebuild')");
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

  importDocument(owner: string, workspace: string, body: string, source: ResourceRef): string | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let id: string | undefined;
      if (this.connection(owner, source.connection, workspace) && !this.resourceRevoked(source.connection, source.resource)) {
        const identical = this.db.prepare(`SELECT id FROM memory WHERE owner=? AND workspace=?
          AND connection=? AND resource=? AND revision=? AND expires IS NULL
          AND (body=? OR EXISTS(SELECT 1 FROM memory_revision r WHERE r.id=memory.id AND r.body=?))
          LIMIT 1`)
          .get(owner, workspace, source.connection, source.resource, source.revision, body, body);
        if (identical) id = String(identical.id);
        else id = this.remember(owner, workspace, body, source);
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
      )`).run(id, owner, workspace, body, source?.connection ?? null, source?.resource ?? null,
      source?.revision ?? null, Date.now(), expires ?? null, source?.connection ?? null,
      source?.connection ?? null, owner, workspace, source?.resource ?? null);
    return inserted.changes === 1 ? id : undefined;
  }

  recall(owner: string, workspace: string, query: string, allowedSources: readonly string[], disabled = false) {
    const term = query.trim();
    if (!term || term.length > 256) return [];
    const allowed = JSON.stringify(allowedSources);
    const filter = `m.owner=? AND m.workspace=? AND COALESCE(s.disabled,0)=? AND (m.expires IS NULL OR m.expires>?)
      AND (m.connection IS NULL OR EXISTS (
        SELECT 1 FROM app_connection a WHERE a.id=m.connection AND a.owner=m.owner AND a.active=1 AND (a.workspace IS NULL OR a.workspace=m.workspace)
        AND a.id IN (SELECT value FROM json_each(?))
      ))`;
    const fields = `m.id,m.body,m.connection,m.resource,m.revision,m.created,
      COALESCE(s.version,1) AS version,COALESCE(s.pinned,0) AS pinned,COALESCE(s.disabled,0) AS disabled`;
    const state = 'LEFT JOIN memory_state s ON s.id=m.id';
    const values = [owner, workspace, Number(disabled), Date.now(), allowed] as const;
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
    const terms = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,32}/gu) ?? [])].slice(0, 8);
    return this.db.prepare(`SELECT m.id,substr(m.body,1,1200) AS body,COALESCE(s.version,1) AS version
      FROM memory m LEFT JOIN memory_state s ON s.id=m.id
      WHERE m.owner=? AND m.workspace=? AND m.connection IS NULL AND COALESCE(s.disabled,0)=0
      AND (m.expires IS NULL OR m.expires>?) AND (s.pinned=1 OR EXISTS (
        SELECT 1 FROM json_each(?) term WHERE instr(lower(m.body),term.value)>0
      )) ORDER BY COALESCE(s.pinned,0) DESC,m.created DESC,m.rowid DESC LIMIT 4`)
      .all(owner, workspace, Date.now(), JSON.stringify(terms))
      .map(row => ({ id: String(row.id), body: String(row.body).toWellFormed(), version: Number(row.version) }));
  }

  revise(owner: string, id: string, expectedVersion: number, change: { body?: string; pinned?: boolean; disabled?: boolean }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT m.body,COALESCE(s.version,1) AS version,COALESCE(s.pinned,0) AS pinned,COALESCE(s.disabled,0) AS disabled
        FROM memory m LEFT JOIN memory_state s ON s.id=m.id
        WHERE m.id=? AND m.owner=? AND (m.expires IS NULL OR m.expires>?)
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
