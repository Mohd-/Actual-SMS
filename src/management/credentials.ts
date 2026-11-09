import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
const digest = (key: string) => createHash('sha256').update(key).digest('hex');

/** Authentication/workflow data only; never an application configuration store. */
export class ManagementCredentials {
  constructor(private db: Database.Database) {
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS management_sessions(id TEXT PRIMARY KEY,expires INTEGER NOT NULL,tag TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasker_credential(singleton INTEGER PRIMARY KEY CHECK(singleton=1),hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS management_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,outcome TEXT NOT NULL,revision TEXT,created_at TEXT NOT NULL);`);
      db.prepare('INSERT OR IGNORE INTO service_migrations(key,value) VALUES(?,?)').run(
        'management-schema:1',
        new Date().toISOString(),
      );
    })();
  }
  session(tag: string) {
    const id = randomBytes(32).toString('hex');
    this.db.prepare('DELETE FROM management_sessions WHERE expires<=?').run(Date.now());
    this.db
      .prepare('INSERT INTO management_sessions VALUES(?,?,?)')
      .run(id, Date.now() + 8 * 60 * 60 * 1000, tag);
    return id;
  }
  validSession(id: string | undefined, tag: string) {
    return Boolean(
      id &&
      this.db
        .prepare('SELECT id FROM management_sessions WHERE id=? AND expires>? AND tag=?')
        .get(id, Date.now(), tag),
    );
  }
  revoke(id: string) {
    this.db.prepare('DELETE FROM management_sessions WHERE id=?').run(id);
  }
  revokeAll() {
    this.db.prepare('DELETE FROM management_sessions').run();
  }
  rotate() {
    return this.db.transaction(() => {
      const key = randomBytes(32).toString('base64url');
      this.db
        .prepare(
          'INSERT INTO tasker_credential VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET hash=excluded.hash',
        )
        .run(digest(key));
      this.audit('tasker.rotate', 'success');
      return key;
    })();
  }
  isTaskerKey(key: unknown) {
    if (typeof key !== 'string' || key.length > 200) return false;
    const row = this.db.prepare('SELECT hash FROM tasker_credential WHERE singleton=1').get() as
      { hash: string } | undefined;
    return Boolean(
      row && timingSafeEqual(Buffer.from(row.hash, 'hex'), Buffer.from(digest(key), 'hex')),
    );
  }
  audit(action: string, outcome: string, revision?: string) {
    this.db
      .prepare(
        "INSERT INTO management_audit(actor,action,outcome,revision,created_at) VALUES('owner',?,?,?,?)",
      )
      .run(action, outcome, revision ?? null, new Date().toISOString());
  }
}
