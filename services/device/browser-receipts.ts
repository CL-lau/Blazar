import { DatabaseSync } from 'node:sqlite';

type ReceiptState = 'started' | 'applied' | 'not_applied';

export class BrowserReceipts {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS browser_receipt (
          id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('started','applied','not_applied'))
        );
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  claim(id: string, fingerprint: string) {
    return this.db.prepare(`INSERT INTO browser_receipt VALUES(?,?,'started') ON CONFLICT(id) DO NOTHING`)
      .run(id, fingerprint).changes === 1;
  }

  get(id: string) {
    return this.db.prepare('SELECT fingerprint,state FROM browser_receipt WHERE id=?')
      .get(id) as { fingerprint: string; state: ReceiptState } | undefined;
  }

  finish(id: string, state: Exclude<ReceiptState, 'started'>) {
    this.db.prepare("UPDATE browser_receipt SET state=? WHERE id=? AND state='started'").run(state, id);
  }

  close() {
    this.db.close();
  }
}
