import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventStore } from '../src/db.js';
import { migrateImportIdentities, legacyImportId } from '../src/import-identity.js';
import { parseSms, PARSER_REVISION } from '../src/parser.js';
import type { ResolvedConfig } from '../src/types.js';
import { banks, parsing } from './fixtures/banks.js';

describe('existing queue migration', () => {
  it('preserves an old on-disk queue, checkpoint, audit and partially imported transaction IDs across reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sms-migration-test-'));
    const path = join(directory, 'events.sqlite');
    let store: EventStore | undefined;
    try {
      const legacy = new Database(path);
      const receipt = '2026-08-22T10:00:00Z';
      const payload = {
        sender: 'SAB',
        message: 'Purchase Card **1234 Amount SAR 25 at Example Store on 2026-08-22 10:05',
        receivedAt: receipt,
      };
      const parsed = parseSms(payload.message, receipt, banks, 'SAB', parsing);
      if (parsed.type !== 'transaction') throw new Error('Invalid synthetic fixture');
      legacy.exec(`CREATE TABLE events(id TEXT PRIMARY KEY,dedupe_key TEXT UNIQUE NOT NULL,status TEXT NOT NULL,payload TEXT,parsed TEXT,suggestion TEXT,parser_reason TEXT,parser_revision INTEGER,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE inbox_sync_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),cursor_date INTEGER NOT NULL,cursor_id INTEGER NOT NULL,updated_at TEXT NOT NULL);`);
      const insert = legacy.prepare(
        'INSERT INTO events VALUES(?,?,?,?,?,NULL,NULL,14,NULL,0,?,?,?)',
      );
      insert.run(
        'imported',
        'tasker:imported',
        'imported',
        JSON.stringify(payload),
        JSON.stringify(parsed.transaction),
        receipt,
        receipt,
        receipt,
      );
      insert.run(
        'pending',
        'tasker:pending',
        'processing',
        JSON.stringify(payload),
        JSON.stringify(parsed.transaction),
        receipt,
        receipt,
        receipt,
      );
      legacy.prepare('INSERT INTO inbox_sync_state VALUES(1,?,?,?)').run(123456789, 42, receipt);
      legacy.close();
      const config: ResolvedConfig = {
        banks,
        parsing,
        accounts: [
          {
            key: 'account',
            id: 'account',
            name: 'Checking',
            match: { bank: 'sab', accountSuffixes: ['1234'] },
          },
        ],
        bankFeesCategoryId: 'fees',
        eligibleCategories: [],
      };
      const expectedId = legacyImportId(parsed.transaction, 'account');
      store = new EventStore(path);
      migrateImportIdentities(store, config);
      expect(store.reserveImportId('imported', 'main', expectedId)).toBe(expectedId);
      expect(store.reserveImportId('pending', 'main', expectedId)).toBe(expectedId);
      store.recover();
      store.replayParserRevision(PARSER_REVISION);
      expect(store.get('imported')?.status).toBe('imported');
      expect(store.get('pending')?.status).toBe('queued');
      expect(store.inboxCheckpoint()).toEqual({ date: 123456789, rowId: 42 });
      expect(store.eventHistory('imported')).toHaveLength(1);
      store.close();
      store = new EventStore(path);
      migrateImportIdentities(store, config);
      expect(store.reserveImportId('pending', 'main', expectedId)).toBe(expectedId);
      const fresh = store.enqueue({ ...payload, eventId: 'fresh' });
      expect(store.reserveImportId(fresh.id, 'main', expectedId)).not.toBe(expectedId);
      expect(store.get('imported')?.payload).toBe(JSON.stringify(payload));
      expect(store.inboxCheckpoint()).toEqual({ date: 123456789, rowId: 42 });
    } finally {
      store?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
