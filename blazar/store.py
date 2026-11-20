import sqlite3
import time
import uuid
from contextlib import contextmanager

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY, channel TEXT NOT NULL, external_id TEXT NOT NULL,
  thread TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  requested INTEGER NOT NULL, UNIQUE(channel, external_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, origin INTEGER NOT NULL UNIQUE REFERENCES events(seq),
  status TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  lease TEXT, expires REAL, result TEXT, environment TEXT NOT NULL, speculative INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  thread TEXT NOT NULL, task TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(thread, task)
);
CREATE TABLE IF NOT EXISTS inbox (
  task TEXT NOT NULL REFERENCES tasks(id), seq INTEGER NOT NULL REFERENCES events(seq),
  PRIMARY KEY(task, seq)
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY, channel TEXT NOT NULL, thread TEXT NOT NULL,
  task TEXT NOT NULL, status TEXT NOT NULL, text TEXT NOT NULL
);
"""


class Store:
    def __init__(self, path):
        self.path = path
        with self.transaction(write=False) as db:
            db.executescript(SCHEMA)

    @contextmanager
    def transaction(self, write=True):
        db = sqlite3.connect(self.path, isolation_level=None, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA foreign_keys=ON")
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            if db.in_transaction:
                db.commit()
        finally:
            db.close()

    def ingest(self, channel, external_id, thread, text, requested):
        with self.transaction() as db:
            return db.execute(
                """INSERT INTO events(channel,external_id,thread,text,requested) VALUES (?,?,?,?,?)
                ON CONFLICT(channel,external_id) DO UPDATE SET external_id=excluded.external_id
                RETURNING seq""", (channel, external_id, thread, text, requested)
            ).fetchone()[0]

    def claim(self, environment, duration):
        with self.transaction() as db:
            row = db.execute(
                """SELECT * FROM tasks WHERE environment=? AND status='queued'
                ORDER BY origin LIMIT 1""", (environment,)
            ).fetchone()
            if row is None:
                return None
            lease = uuid.uuid4().hex
            db.execute(
                """UPDATE tasks SET status='running', lease=?, expires=?,
                attempts=attempts+1 WHERE id=?""", (lease, time.time()+duration, row['id'])
            )
            events = db.execute(
                """SELECT e.* FROM events e JOIN inbox i ON i.seq=e.seq
                WHERE i.task=? ORDER BY e.seq""", (row['id'],)
            ).fetchall()
            return {**dict(row), 'lease': lease, 'events': [dict(e) for e in events]}

    def renew(self, task, lease, duration):
        now = time.time()
        with self.transaction() as db:
            return bool(db.execute(
                """UPDATE tasks SET expires=? WHERE id=? AND lease=?
                AND status='running' AND expires>?""", (now+duration, task, lease, now)
            ).rowcount)

    def finish(self, task, lease, cursor, result, report):
        with self.transaction() as db:
            row = db.execute(
                "SELECT * FROM tasks WHERE id=? AND lease=? AND status='running' AND expires>?",
                (task, lease, time.time())
            ).fetchone()
            if row is None:
                return False
            latest = db.execute("SELECT max(seq) FROM inbox WHERE task=?", (task,)).fetchone()[0]
            if cursor != latest:
                db.execute("UPDATE tasks SET status='queued',lease=NULL,expires=NULL WHERE id=?", (task,))
                return True
            db.execute(
                """UPDATE tasks SET status='done', result=?,cursor=?,lease=NULL,expires=NULL
                WHERE id=?""", (result, cursor, task)
            )
            if report or not row['speculative']:
                self.publish(db, row, 'done', result)
            return True

    def watchdog(self, max_attempts):
        with self.transaction() as db:
            rows = db.execute(
                "SELECT * FROM tasks WHERE status='running' AND expires<=?", (time.time(),)
            ).fetchall()
            for row in rows:
                exhausted = row['attempts'] >= max_attempts
                db.execute(
                    "UPDATE tasks SET status=?,lease=NULL,expires=NULL WHERE id=?",
                    ('failed' if exhausted else 'queued', row['id'])
                )
                if exhausted and not row['speculative']:
                    self.publish(db, row, 'failed', 'Worker lease expired repeatedly.')

    @staticmethod
    def publish(db, row, status, text):
        event = db.execute("SELECT * FROM events WHERE seq=?", (row['origin'],)).fetchone()
        db.execute(
            "INSERT INTO outbox(channel,thread,task,status,text) VALUES (?,?,?,?,?)",
            (event['channel'], event['thread'], row['id'], status, text)
        )

    def recall(self, task):
        with self.transaction(write=False) as db:
            row = db.execute("SELECT * FROM tasks WHERE id=?", (task,)).fetchone()
            if row is None:
                return None
            events = db.execute(
                """SELECT e.* FROM inbox i JOIN events e ON e.seq=i.seq
                WHERE i.task=? ORDER BY e.seq""", (task,)
            )
            result = dict(row)
            result.pop('lease')
            return {**result, 'events': [dict(event) for event in events]}

    def messages(self, channel, after):
        with self.transaction(write=False) as db:
            return [dict(row) for row in db.execute(
                "SELECT * FROM outbox WHERE channel=? AND id>? ORDER BY id LIMIT 100",
                (channel, after)
            )]
