import type { DatabaseSync } from 'node:sqlite';
import { sqliteTransaction } from '../../../packages/storage/sqlite.ts';

export function initializeMemorySchema(db: DatabaseSync): boolean {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS app_connection (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, app TEXT NOT NULL,
      account TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, workspace TEXT, scope_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS app_write (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, connection TEXT NOT NULL REFERENCES app_connection(id),
      workspace TEXT NOT NULL, scope_version INTEGER NOT NULL, capability TEXT NOT NULL,
      definition_revision TEXT NOT NULL, input TEXT NOT NULL, expires INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','dispatching','succeeded','unavailable','denied','outcome_unknown')),
      backend TEXT
    );
    CREATE TABLE IF NOT EXISTS app_write_reconciliation (
      proposal TEXT PRIMARY KEY REFERENCES app_write(id), resolution TEXT NOT NULL
        CHECK(resolution IN ('applied','not_applied')),
      evidence TEXT NOT NULL, checked_at INTEGER NOT NULL
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
      workspace TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL, started INTEGER NOT NULL,
      scope_version INTEGER, read_backend TEXT
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
    CREATE TABLE IF NOT EXISTS memory_derivation (
      id TEXT PRIMARY KEY REFERENCES memory(id) ON DELETE CASCADE,
      evidence_id TEXT NOT NULL, evidence_version INTEGER NOT NULL
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
      id TEXT PRIMARY KEY REFERENCES memory(id) ON DELETE CASCADE, read_backend TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_task_origin (
      id TEXT PRIMARY KEY REFERENCES memory(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL, task_version INTEGER NOT NULL, UNIQUE(task_id,task_version)
    );
    CREATE TABLE IF NOT EXISTS document_head (
      owner TEXT NOT NULL, workspace TEXT NOT NULL, connection TEXT NOT NULL REFERENCES app_connection(id),
      resource TEXT NOT NULL, memory_id TEXT NOT NULL, request_id INTEGER, primary_verified INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(owner,workspace,connection,resource)
    );
    CREATE INDEX IF NOT EXISTS memory_scope ON memory(owner,workspace,created);
    CREATE INDEX IF NOT EXISTS memory_connection ON memory(connection);
    CREATE INDEX IF NOT EXISTS memory_expiry ON memory(expires) WHERE expires IS NOT NULL;
  `);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('memory_state') WHERE name='disabled'").get()) {
    db.exec('ALTER TABLE memory_state ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('app_connection') WHERE name='scope_version'").get()) {
    db.exec('ALTER TABLE app_connection ADD COLUMN scope_version INTEGER NOT NULL DEFAULT 1');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('app_usage') WHERE name='scope_version'").get()) {
    db.exec('ALTER TABLE app_usage ADD COLUMN scope_version INTEGER');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('app_usage') WHERE name='read_backend'").get()) {
    db.exec('ALTER TABLE app_usage ADD COLUMN read_backend TEXT');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('document_import') WHERE name='read_backend'").get()) {
    db.exec('ALTER TABLE document_import ADD COLUMN read_backend TEXT');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('document_head') WHERE name='primary_verified'").get()) {
    db.exec(`ALTER TABLE document_head ADD COLUMN primary_verified INTEGER NOT NULL DEFAULT 0;
      UPDATE document_head SET primary_verified=1 WHERE EXISTS(
        SELECT 1 FROM document_import i WHERE i.id=document_head.memory_id AND json_extract(i.read_backend,'$.fallback')=0
      );`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS app_usage_connection_health ON app_usage(connection,scope_version,id)
    WHERE operation='health' AND status<>'started'`);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS document_sync_connection_changed
    AFTER UPDATE OF active,scope_version ON app_connection
    WHEN old.active<>new.active OR old.scope_version<>new.scope_version
    BEGIN
      UPDATE document_sync SET lease_token=NULL,lease_expires=NULL WHERE connection=new.id;
    END;
  `);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('app_connection') WHERE name='workspace'").get()) {
    db.exec('ALTER TABLE app_connection ADD COLUMN workspace TEXT');
  }
  const option = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get();
  const fullText = option?.enabled === 1;
  const dropTriggers = `
    DROP TRIGGER IF EXISTS memory_insert;
    DROP TRIGGER IF EXISTS memory_delete;
    DROP TRIGGER IF EXISTS memory_update;
    DROP TRIGGER IF EXISTS memory_connection_scope;
    DROP TRIGGER IF EXISTS memory_document_access_insert;
    DROP TRIGGER IF EXISTS memory_document_access_update;
  `;
  if (!fullText) {
    db.exec(dropTriggers);
    return false;
  }
  sqliteTransaction(db, () => {
    const initialized = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_document_access_update'").get();
    if (!initialized) {
      db.exec(dropTriggers);
      db.exec('DROP TABLE IF EXISTS memory_search');
      db.exec('DROP VIEW IF EXISTS memory_indexable');
    }
    db.exec(`
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
    if (!initialized) db.exec("INSERT INTO memory_search(memory_search) VALUES('rebuild')");
  });
  return true;
}
