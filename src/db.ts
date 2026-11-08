import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type {
  EventStatus,
  InboxCheckpoint,
  InboxSyncOutcome,
  InboxSyncRow,
  SmsInput,
} from './types.js';
import { normalizeText, type ParserReason } from './parser.js';

export interface StoredEvent {
  id: string;
  dedupe_key: string;
  status: EventStatus;
  payload: string | null;
  parsed: string | null;
  suggestion: string | null;
  parser_reason: ParserReason | null;
  parser_revision: number | null;
  error: string | null;
  attempts: number;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
  enrichment_status: string | null;
  actual_transaction_id: string | null;
}
export interface MerchantMapping {
  account_id: string;
  merchant_key: string;
  payee: string;
  category_id: string;
  source: 'actual' | 'local';
  source_ref: string | null;
  decision_at: string;
  updated_at: string;
}
export class InboxCheckpointConflict extends Error {
  constructor(readonly checkpoint: InboxCheckpoint | null) {
    super('Inbox checkpoint changed');
  }
}

export interface InboxSyncEntry {
  row: InboxSyncRow;
  input?: SmsInput;
  skipped?: Extract<InboxSyncOutcome, 'unsupported' | 'empty'>;
}

export class EventStore {
  readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,dedupe_key TEXT UNIQUE NOT NULL,status TEXT NOT NULL,payload TEXT,parsed TEXT,suggestion TEXT,parser_reason TEXT,parser_revision INTEGER,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS balances(account_alias TEXT NOT NULL,observed_at TEXT NOT NULL,balance_cents INTEGER NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(account_alias,observed_at,event_id));
    CREATE TABLE IF NOT EXISTS transfers(id INTEGER PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, source_alias TEXT NOT NULL, counterparty_alias TEXT, principal_cents INTEGER NOT NULL, occurred_at TEXT NOT NULL, matched_event_id TEXT);
    CREATE TABLE IF NOT EXISTS service_migrations(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS event_history(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL,from_status TEXT,to_status TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS enrichment_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL,status TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS merchant_mappings(account_id TEXT NOT NULL,merchant_key TEXT NOT NULL,payee TEXT NOT NULL,category_id TEXT NOT NULL,source TEXT NOT NULL,source_ref TEXT,decision_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(account_id,merchant_key));
    CREATE TABLE IF NOT EXISTS actual_mapping_observations(actual_transaction_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,merchant_key TEXT NOT NULL,payee TEXT NOT NULL,category_id TEXT NOT NULL,transaction_date TEXT NOT NULL,decision_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS local_mapping_observations(source_ref TEXT PRIMARY KEY,account_id TEXT NOT NULL,merchant_key TEXT NOT NULL,payee TEXT NOT NULL,category_id TEXT NOT NULL,decision_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox_sync_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),cursor_date INTEGER NOT NULL,cursor_id INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS event_import_ids(event_id TEXT NOT NULL,part TEXT NOT NULL,legacy_id TEXT NOT NULL,imported_id TEXT NOT NULL,PRIMARY KEY(event_id,part));
    CREATE INDEX IF NOT EXISTS event_import_ids_legacy ON event_import_ids(legacy_id);
    CREATE INDEX IF NOT EXISTS event_queue ON events(status,next_attempt_at);
    CREATE INDEX IF NOT EXISTS event_history_event ON event_history(event_id,id);
    CREATE INDEX IF NOT EXISTS enrichment_attempts_event ON enrichment_attempts(event_id,id);
    CREATE INDEX IF NOT EXISTS events_history_page ON events(created_at,id);
  `);
    const columns = this.db.prepare('PRAGMA table_info(events)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'parser_reason'))
      this.db.exec('ALTER TABLE events ADD COLUMN parser_reason TEXT');
    if (!columns.some(column => column.name === 'parser_revision'))
      this.db.exec('ALTER TABLE events ADD COLUMN parser_revision INTEGER');
    if (!columns.some(column => column.name === 'enrichment_status'))
      this.db.exec('ALTER TABLE events ADD COLUMN enrichment_status TEXT');
    if (!columns.some(column => column.name === 'actual_transaction_id'))
      this.db.exec('ALTER TABLE events ADD COLUMN actual_transaction_id TEXT');
    if (!columns.some(column => column.name === 'import_identity_revision'))
      this.db.exec(
        'ALTER TABLE events ADD COLUMN import_identity_revision INTEGER NOT NULL DEFAULT 0',
      );
    this.backfillAudit();
  }
  enqueue(input: SmsInput): { id: string; duplicate: boolean } {
    return this.db.transaction(() => this.enqueueInTransaction(input))();
  }
  private enqueueInTransaction(input: SmsInput): { id: string; duplicate: boolean } {
    const legacyKey = `hash:${createHash('sha256')
      .update(`${normalizeText(input.sender ?? '').toLowerCase()}\n${normalizeText(input.message)}`)
      .digest('hex')}`;
    const key = input.eventId
      ? `tasker:${input.eventId}`
      : `hash-v2:${createHash('sha256')
          .update(`${legacyKey}\n${new Date(input.receivedAt).toISOString()}`)
          .digest('hex')}`;
    let old = this.db.prepare('SELECT id FROM events WHERE dedupe_key=?').get(key) as
      { id: string } | undefined;
    if (!old && !input.eventId) {
      const legacy = this.db
        .prepare('SELECT id,payload FROM events WHERE dedupe_key=?')
        .get(legacyKey) as { id: string; payload: string | null } | undefined;
      if (
        legacy?.payload &&
        new Date((JSON.parse(legacy.payload) as SmsInput).receivedAt).getTime() ===
          new Date(input.receivedAt).getTime()
      )
        old = legacy;
    }
    if (old) {
      const event = this.get(old.id)!;
      this.insertHistory(old.id, event.status, event.status, { duplicateSubmission: true });
      return { id: old.id, duplicate: true };
    }
    const id = input.eventId || randomUUID(),
      now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO events(id,dedupe_key,status,payload,next_attempt_at,created_at,updated_at,import_identity_revision) VALUES(?,?,?,?,?,?,?,1)',
      )
      .run(id, key, 'queued', JSON.stringify(input), now, now, now);
    this.insertHistory(id, null, 'queued', { input });
    return { id, duplicate: false };
  }
  startInboxSync(nowMillis = Date.now()): InboxCheckpoint {
    return this.db.transaction(() => {
      const existing = this.inboxCheckpoint();
      if (existing) return existing;
      const checkpoint = { date: Math.max(0, nowMillis - 7 * 24 * 60 * 60 * 1000), rowId: 0 };
      this.db
        .prepare(
          'INSERT INTO inbox_sync_state(singleton,cursor_date,cursor_id,updated_at) VALUES(1,?,?,?)',
        )
        .run(checkpoint.date, checkpoint.rowId, new Date(nowMillis).toISOString());
      return checkpoint;
    })();
  }
  inboxCheckpoint(): InboxCheckpoint | undefined {
    const row = this.db
      .prepare('SELECT cursor_date,cursor_id FROM inbox_sync_state WHERE singleton=1')
      .get() as { cursor_date: number; cursor_id: number } | undefined;
    return row ? { date: row.cursor_date, rowId: row.cursor_id } : undefined;
  }
  setInboxCheckpoint(date: number, expected: InboxCheckpoint | null) {
    if (!Number.isSafeInteger(date) || date < 0 || date > Date.now())
      throw new Error('Invalid checkpoint date');
    return this.db.transaction(() => {
      const current = this.inboxCheckpoint() ?? null;
      if (current?.date !== expected?.date || current?.rowId !== expected?.rowId)
        throw new InboxCheckpointConflict(current);
      const checkpoint = { date, rowId: 0 };
      this.db
        .prepare(
          'INSERT INTO inbox_sync_state(singleton,cursor_date,cursor_id,updated_at) VALUES(1,?,0,?) ON CONFLICT(singleton) DO UPDATE SET cursor_date=excluded.cursor_date,cursor_id=0,updated_at=excluded.updated_at',
        )
        .run(date, new Date().toISOString());
      return checkpoint;
    })();
  }
  counts() {
    return this.db.prepare('SELECT status,COUNT(*) count FROM events GROUP BY status').all() as {
      status: EventStatus;
      count: number;
    }[];
  }
  commitInboxBatch(expected: InboxCheckpoint, entries: InboxSyncEntry[]) {
    return this.db.transaction(() => {
      const current = this.inboxCheckpoint();
      if (!current || current.date !== expected.date || current.rowId !== expected.rowId)
        throw new InboxCheckpointConflict(current ?? this.startInboxSync());
      const results = entries.map(entry => {
        if (!entry.input)
          return {
            rowId: entry.row.rowId,
            date: entry.row.date,
            outcome: entry.skipped!,
          };
        const enqueued = this.enqueueInTransaction(entry.input);
        return {
          rowId: entry.row.rowId,
          date: entry.row.date,
          outcome: (enqueued.duplicate ? 'duplicate' : 'queued') as InboxSyncOutcome,
          eventId: enqueued.id,
        };
      });
      const last = entries.at(-1)!.row;
      const checkpoint = { date: last.date, rowId: last.rowId };
      this.db
        .prepare(
          'UPDATE inbox_sync_state SET cursor_date=?,cursor_id=?,updated_at=? WHERE singleton=1',
        )
        .run(checkpoint.date, checkpoint.rowId, new Date().toISOString());
      return { checkpoint, results };
    })();
  }
  rewindInboxSync(date: number): { checkpoint: InboxCheckpoint; changed: boolean } {
    return this.db.transaction(() => {
      const current = this.inboxCheckpoint() ?? this.startInboxSync();
      if (date > current.date || (date === current.date && current.rowId === 0))
        return { checkpoint: current, changed: false };
      const checkpoint = { date, rowId: 0 };
      this.db
        .prepare(
          'UPDATE inbox_sync_state SET cursor_date=?,cursor_id=0,updated_at=? WHERE singleton=1',
        )
        .run(date, new Date().toISOString());
      return { checkpoint, changed: true };
    })();
  }
  get(id: string): StoredEvent | undefined {
    return this.db.prepare('SELECT * FROM events WHERE id=?').get(id) as StoredEvent | undefined;
  }
  legacyImportEvents(): StoredEvent[] {
    return this.db
      .prepare(
        'SELECT * FROM events WHERE import_identity_revision=0 AND parsed IS NOT NULL ORDER BY created_at,rowid',
      )
      .all() as StoredEvent[];
  }
  completeImportIdentityMigration() {
    this.db
      .prepare('UPDATE events SET import_identity_revision=1 WHERE import_identity_revision=0')
      .run();
  }
  seedImportId(eventId: string, part: string, id: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO event_import_ids VALUES(?,?,?,?)')
      .run(eventId, part, id, id);
  }
  reserveImportId(eventId: string, part: string, legacyId: string): string {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT imported_id FROM event_import_ids WHERE event_id=? AND part=?')
        .get(eventId, part) as { imported_id: string } | undefined;
      if (existing) return existing.imported_id;
      const collision = this.db
        .prepare('SELECT 1 FROM event_import_ids WHERE legacy_id=? LIMIT 1')
        .get(legacyId);
      const id = collision
        ? `${legacyId}:${createHash('sha256').update(eventId).digest('hex')}`
        : legacyId;
      this.db
        .prepare('INSERT INTO event_import_ids VALUES(?,?,?,?)')
        .run(eventId, part, legacyId, id);
      return id;
    })();
  }
  claim(): StoredEvent | undefined {
    const tx = this.db.transaction(() => {
      const e = this.db
        .prepare(
          "SELECT * FROM events WHERE status='queued' AND next_attempt_at<=? ORDER BY created_at, rowid LIMIT 1",
        )
        .get(new Date().toISOString()) as StoredEvent | undefined;
      if (e) {
        const now = new Date().toISOString();
        this.db
          .prepare("UPDATE events SET status='processing',updated_at=? WHERE id=?")
          .run(now, e.id);
        this.insertHistory(e.id, 'queued', 'processing', { action: 'claim' }, now);
      }
      return e;
    });
    return tx();
  }
  update(
    id: string,
    status: EventStatus,
    fields: {
      parsed?: unknown;
      suggestion?: unknown;
      parserReason?: ParserReason;
      parserRevision?: number;
      error?: string;
      attempts?: number;
      nextAttemptAt?: string;
      enrichmentStatus?: string;
      actualTransactionId?: string;
    } = {},
  ) {
    this.db.transaction(() => {
      const current = this.get(id);
      if (!current) return;
      const now = new Date().toISOString();
      this.db
        .prepare(
          'UPDATE events SET status=?,parsed=COALESCE(?,parsed),suggestion=COALESCE(?,suggestion),parser_reason=?,parser_revision=COALESCE(?,parser_revision),error=?,attempts=COALESCE(?,attempts),next_attempt_at=COALESCE(?,next_attempt_at),enrichment_status=COALESCE(?,enrichment_status),actual_transaction_id=COALESCE(?,actual_transaction_id),updated_at=? WHERE id=?',
        )
        .run(
          status,
          fields.parsed ? JSON.stringify(fields.parsed) : null,
          fields.suggestion ? JSON.stringify(fields.suggestion) : null,
          fields.parserReason ?? null,
          fields.parserRevision ?? null,
          fields.error ?? null,
          fields.attempts ?? null,
          fields.nextAttemptAt ?? null,
          fields.enrichmentStatus ?? null,
          fields.actualTransactionId ?? null,
          now,
          id,
        );
      this.insertHistory(id, current.status, status, fields, now);
    })();
  }
  recover() {
    const events = this.db.prepare("SELECT id FROM events WHERE status='processing'").all() as {
      id: string;
    }[];
    for (const event of events)
      this.update(event.id, 'queued', { nextAttemptAt: new Date().toISOString() });
  }
  /**
   * A parser release can revive every non-imported parser outcome once.
   * Imported events are deliberately excluded: Actual's stable imported IDs
   * remain the final deduplication safeguard, but replay must not create
   * needless API calls.
   */
  replayParserRevision(revision: number): number {
    const key = `parser-replay:${revision}`;
    const migration = this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM service_migrations WHERE key=?').get(key)) return 0;
      const now = new Date().toISOString();
      const replayed = this.db
        .prepare(
          "SELECT id,status FROM events WHERE status IN ('ignored','needs_review','queued','failed') AND payload IS NOT NULL AND (parser_revision IS NULL OR parser_revision<?)",
        )
        .all(revision) as { id: string; status: EventStatus }[];
      const result = this.db
        .prepare(
          "UPDATE events SET status='queued',parser_reason=NULL,parser_revision=?,error=NULL,attempts=0,next_attempt_at=?,updated_at=? WHERE status IN ('ignored','needs_review','queued','failed') AND payload IS NOT NULL AND (parser_revision IS NULL OR parser_revision<?)",
        )
        .run(revision, now, now, revision);
      for (const event of replayed)
        this.insertHistory(event.id, event.status, 'queued', { parserRevision: revision }, now);
      this.db.prepare('INSERT INTO service_migrations(key,value) VALUES(?,?)').run(key, now);
      return result.changes;
    });
    return migration() as number;
  }
  previousBalance(alias: string, at: string): number | undefined {
    return (
      this.db
        .prepare(
          'SELECT balance_cents FROM balances WHERE account_alias=? AND observed_at<? ORDER BY observed_at DESC LIMIT 1',
        )
        .get(alias, at) as { balance_cents: number } | undefined
    )?.balance_cents;
  }
  addBalance(alias: string, at: string, balance: number, event: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO balances VALUES(?,?,?,?)')
      .run(alias, at, balance, event);
  }
  findTransferCounterparts(
    eventId: string,
    alias: string,
    amount: number,
    at: string,
  ): { event_id: string; source_alias: string }[] {
    return this.db
      .prepare(
        'SELECT event_id,source_alias FROM transfers WHERE event_id<>? AND source_alias<>? AND principal_cents=? AND julianday(occurred_at) BETWEEN julianday(?) - 15.0 / 1440 AND julianday(?) + 15.0 / 1440 AND (matched_event_id IS NULL OR matched_event_id=?) ORDER BY ABS(julianday(occurred_at)-julianday(?))',
      )
      .all(eventId, alias, -amount, at, at, eventId, at) as {
      event_id: string;
      source_alias: string;
    }[];
  }
  recordTransfer(
    eventId: string,
    alias: string,
    counterparty: string | undefined,
    amount: number,
    at: string,
    matched?: string,
  ) {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO transfers(event_id,source_alias,counterparty_alias,principal_cents,occurred_at,matched_event_id) VALUES(?,?,?,?,?,?)',
      )
      .run(eventId, alias, counterparty ?? null, amount, at, matched ?? null);
    if (matched)
      this.db
        .prepare('UPDATE transfers SET matched_event_id=? WHERE event_id=?')
        .run(eventId, matched);
  }
  purge(days: number) {
    void days;
  }
  recordEnrichment(eventId: string, status: string, details: unknown) {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO enrichment_attempts(event_id,status,details,created_at) VALUES(?,?,?,?)',
        )
        .run(eventId, status, JSON.stringify(details), now);
      this.db
        .prepare('UPDATE events SET enrichment_status=?,updated_at=? WHERE id=?')
        .run(status, now, eventId);
    })();
  }
  eventHistory(eventId: string) {
    return this.db
      .prepare(
        'SELECT id,from_status,to_status,details,created_at FROM event_history WHERE event_id=? ORDER BY id',
      )
      .all(eventId) as {
      id: number;
      from_status: string | null;
      to_status: string;
      details: string;
      created_at: string;
    }[];
  }
  enrichmentAttempts(eventId: string) {
    return this.db
      .prepare(
        'SELECT id,status,details,created_at FROM enrichment_attempts WHERE event_id=? ORDER BY id',
      )
      .all(eventId) as { id: number; status: string; details: string; created_at: string }[];
  }
  list(options: {
    limit: number;
    before?: { createdAt: string; id: string };
    status?: string;
    enrichmentStatus?: string;
    from?: string;
    to?: string;
  }) {
    const where: string[] = [];
    const values: unknown[] = [];
    if (options.before) {
      where.push('(created_at<? OR (created_at=? AND id<?))');
      values.push(options.before.createdAt, options.before.createdAt, options.before.id);
    }
    for (const [column, value, operator] of [
      ['status', options.status, '='],
      ['enrichment_status', options.enrichmentStatus, '='],
      ['created_at', options.from, '>='],
      ['created_at', options.to, '<='],
    ] as const) {
      if (value) {
        where.push(`${column}${operator}?`);
        values.push(value);
      }
    }
    return this.db
      .prepare(
        `SELECT id,status,attempts,parser_reason,error,enrichment_status,created_at,updated_at FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(...values, options.limit) as Pick<
      StoredEvent,
      | 'id'
      | 'status'
      | 'attempts'
      | 'parser_reason'
      | 'error'
      | 'enrichment_status'
      | 'created_at'
      | 'updated_at'
    >[];
  }
  mapping(accountId: string, merchantKey: string): MerchantMapping | undefined {
    return this.db
      .prepare('SELECT * FROM merchant_mappings WHERE account_id=? AND merchant_key=?')
      .get(accountId, merchantKey) as MerchantMapping | undefined;
  }
  putMapping(mapping: Omit<MerchantMapping, 'updated_at'>) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO merchant_mappings(account_id,merchant_key,payee,category_id,source,source_ref,decision_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(account_id,merchant_key) DO UPDATE SET payee=excluded.payee,category_id=excluded.category_id,source=excluded.source,source_ref=excluded.source_ref,decision_at=excluded.decision_at,updated_at=excluded.updated_at
         WHERE excluded.decision_at>=merchant_mappings.decision_at`,
      )
      .run(
        mapping.account_id,
        mapping.merchant_key,
        mapping.payee,
        mapping.category_id,
        mapping.source,
        mapping.source_ref,
        mapping.decision_at,
        now,
      );
  }
  putLocalMapping(mapping: Omit<MerchantMapping, 'updated_at' | 'source'>) {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO local_mapping_observations(source_ref,account_id,merchant_key,payee,category_id,decision_at,updated_at) VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(source_ref) DO UPDATE SET account_id=excluded.account_id,merchant_key=excluded.merchant_key,payee=excluded.payee,category_id=excluded.category_id,decision_at=excluded.decision_at,updated_at=excluded.updated_at`,
        )
        .run(
          mapping.source_ref,
          mapping.account_id,
          mapping.merchant_key,
          mapping.payee,
          mapping.category_id,
          mapping.decision_at,
          now,
        );
      this.putMapping({ ...mapping, source: 'local' });
    })();
  }
  replaceActualMappings(
    inputs: {
      actualTransactionId: string;
      accountId: string;
      merchantKey: string;
      payee: string;
      categoryId: string;
      transactionDate: string;
    }[],
    now: string,
  ) {
    this.db.transaction(() => {
      const old = new Map(
        (
          this.db
            .prepare(
              'SELECT actual_transaction_id,category_id,decision_at FROM actual_mapping_observations',
            )
            .all() as {
            actual_transaction_id: string;
            category_id: string;
            decision_at: string;
          }[]
        ).map(observation => [observation.actual_transaction_id, observation]),
      );
      this.db.prepare('DELETE FROM actual_mapping_observations').run();
      const insert = this.db.prepare(
        'INSERT INTO actual_mapping_observations(actual_transaction_id,account_id,merchant_key,payee,category_id,transaction_date,decision_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      );
      for (const input of inputs) {
        const previous = old.get(input.actualTransactionId);
        const decisionAt =
          previous && previous.category_id !== input.categoryId
            ? now
            : (previous?.decision_at ?? `${input.transactionDate}T00:00:00.000Z`);
        insert.run(
          input.actualTransactionId,
          input.accountId,
          input.merchantKey,
          input.payee,
          input.categoryId,
          input.transactionDate,
          decisionAt,
          now,
        );
      }
      this.db.prepare('DELETE FROM merchant_mappings').run();
      const candidates = this.db
        .prepare(
          `SELECT account_id,merchant_key,payee,category_id,'local' source,source_ref,decision_at FROM local_mapping_observations
           UNION ALL
           SELECT account_id,merchant_key,payee,category_id,'actual' source,actual_transaction_id source_ref,decision_at FROM actual_mapping_observations
           ORDER BY decision_at,source_ref`,
        )
        .all() as Omit<MerchantMapping, 'updated_at'>[];
      for (const candidate of candidates) this.putMapping(candidate);
    })();
  }
  private insertHistory(
    eventId: string,
    fromStatus: string | null,
    toStatus: string,
    details: unknown,
    createdAt = new Date().toISOString(),
  ) {
    this.db
      .prepare(
        'INSERT INTO event_history(event_id,from_status,to_status,details,created_at) VALUES(?,?,?,?,?)',
      )
      .run(eventId, fromStatus, toStatus, JSON.stringify(details), createdAt);
  }
  private backfillAudit() {
    const key = 'audit-v1';
    if (this.db.prepare('SELECT 1 FROM service_migrations WHERE key=?').get(key)) return;
    this.db.transaction(() => {
      const events = this.db.prepare('SELECT * FROM events').all() as StoredEvent[];
      for (const event of events) {
        if (!this.db.prepare('SELECT 1 FROM event_history WHERE event_id=?').get(event.id))
          this.insertHistory(event.id, null, event.status, { legacy: true }, event.updated_at);
        if (
          event.suggestion &&
          !this.db.prepare('SELECT 1 FROM enrichment_attempts WHERE event_id=?').get(event.id)
        ) {
          this.db
            .prepare(
              'INSERT INTO enrichment_attempts(event_id,status,details,created_at) VALUES(?,?,?,?)',
            )
            .run(
              event.id,
              'legacy_success',
              JSON.stringify({ legacy: true, suggestion: JSON.parse(event.suggestion) }),
              event.updated_at,
            );
          this.db
            .prepare('UPDATE events SET enrichment_status=? WHERE id=?')
            .run('legacy_success', event.id);
        }
      }
      this.db
        .prepare('INSERT INTO service_migrations(key,value) VALUES(?,?)')
        .run(key, new Date().toISOString());
    })();
  }
  close() {
    this.db.close();
  }
}
