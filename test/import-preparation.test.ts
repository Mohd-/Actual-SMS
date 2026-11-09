import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventStore } from '../src/db.js';
import { Runtime } from '../src/runtime.js';
import { Processor } from '../src/processor.js';
import { NoopEnricher } from '../src/enricher.js';
import { legacyImportId, migrateImportIdentities } from '../src/import-identity.js';
import { parseSms } from '../src/parser.js';
import { runtimeFixture } from './fixtures/runtime.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const input = {
  sender: 'SAB',
  message: 'Purchase Card:1234 Amount: SAR 10 at Coffee',
  receivedAt: '2026-08-22T10:10:30+03:00',
};
async function setup() {
  const f = await runtimeFixture();
  cleanup.push(f.cleanup);
  const path = join(f.directory, 'queue.sqlite');
  let store = new EventStore(path);
  cleanup.push(async () => store.close());
  const result = parseSms(
    input.message,
    input.receivedAt,
    f.config.banks,
    input.sender,
    f.config.parsing,
  );
  if (result.type !== 'transaction') throw new Error('Bad fixture');
  const tx = { ...result.transaction, accountAlias: undefined };
  store.enqueue({ ...input, eventId: 'historical' });
  store.update('historical', 'imported', { parsed: tx });
  store.db.prepare('UPDATE events SET import_identity_revision=0 WHERE id=?').run('historical');
  await writeFile(
    f.paths.accounts,
    'accounts:\n  - actualName: Checking\n    match:\n      bank: sab\n      transactionKinds: [purchase]\nbankFeesCategory: Fees\n',
  );
  const runtime = new Runtime(f.actual, f.config, f.paths, snapshot =>
    migrateImportIdentities(store, snapshot),
  );
  return {
    ...f,
    get store() {
      return store;
    },
    tx,
    runtime,
    reopen: () => {
      store.close();
      store = new EventStore(path);
    },
  };
}

describe('historical identity preparation', () => {
  it('does not claim during outage startup and prepares suffix-free identities before recovery resumes work', async () => {
    const f = await setup();
    f.config.accounts = [];
    let offline = true;
    f.actual.initialize = async () => {
      if (offline) throw new Error('Offline');
    };
    const processor = new Processor(
      f.store,
      f.actual,
      new NoopEnricher(),
      f.config,
      5,
      0.7,
      undefined,
      f.runtime.gate,
    );
    f.store.enqueue({ ...input, eventId: 'fresh' });
    const history = f.store.eventHistory('historical');
    await expect(f.runtime.reconnect()).rejects.toThrow();
    await processor.tick();
    expect(f.store.get('fresh')?.status).toBe('queued');
    expect(f.store.eventHistory('fresh')).toHaveLength(1);
    expect(f.store.legacyImportEvents()).toHaveLength(1);
    offline = false;
    await f.runtime.reconnect();
    const expected = legacyImportId(f.tx, 'checking');
    expect(f.store.reserveImportId('historical', 'main', expected)).toBe(expected);
    expect(f.store.reserveImportId('fresh', 'main', expected)).not.toBe(expected);
    f.reopen();
    await f.runtime.reconnect();
    expect(f.store.reserveImportId('historical', 'main', expected)).toBe(expected);
    expect(f.store.get('historical')?.status).toBe('imported');
    expect(f.store.eventHistory('historical')).toEqual(history);
    expect(f.runtime.status().ready).toBe(true);
  });

  it('keeps imports paused and an unresolved historical row pending', async () => {
    const f = await setup();
    await writeFile(
      f.paths.accounts,
      'accounts:\n  - actualName: Checking\n    match:\n      bank: sab\n      transactionKinds: [refund]\nbankFeesCategory: Fees\n',
    );
    await expect(f.runtime.reconnect()).rejects.toThrow();
    expect(f.runtime.status().ready).toBe(false);
    expect(f.store.legacyImportEvents()).toHaveLength(1);
  });

  it('rolls back identity reservations when preparation is interrupted', async () => {
    const f = await setup();
    f.store.db.exec(
      "CREATE TRIGGER interrupt_preparation BEFORE UPDATE OF import_identity_revision ON events BEGIN SELECT RAISE(ABORT,'interrupted'); END",
    );
    await expect(f.runtime.reconnect()).rejects.toThrow();
    expect(f.store.legacyImportEvents()).toHaveLength(1);
    f.store.db.exec('DROP TRIGGER interrupt_preparation');
    const expected = legacyImportId(f.tx, 'checking');
    // A different event still gets the base ID: the interrupted run left no orphan reservation.
    expect(f.store.reserveImportId('rollback-probe', 'main', expected)).toBe(expected);
    await f.runtime.reconnect();
    expect(f.store.reserveImportId('historical', 'main', expected)).toBe(expected);
  });

  it('detects already mis-marked historical identities without resetting flags or inventing reservations', async () => {
    const f = await setup();
    f.store.db.exec(
      "UPDATE events SET import_identity_revision=1 WHERE id='historical'; DELETE FROM service_migrations WHERE key='import-execution:1'",
    );
    f.reopen();
    f.store.enqueue({ ...input, eventId: 'fresh' });
    await expect(f.runtime.reconnect()).rejects.toThrow();
    expect(f.runtime.status()).toMatchObject({
      ready: false,
      error: expect.stringContaining('preparation'),
    });
    const processor = new Processor(f.store, f.actual, new NoopEnricher(), f.config);
    await processor.tick();
    expect(f.store.eventHistory('fresh')).toHaveLength(1);
    expect(f.store.get('historical')?.status).toBe('imported');
    // Migration completion is not silently reset, nor is current routing used to repair it.
    expect(f.store.legacyImportEvents()).toEqual([]);
    f.reopen();
    await expect(f.runtime.reconnect()).rejects.toThrow();
  });

  it('holds never-parsed legacy rows with Actual write evidence instead of fabricating a fingerprint', async () => {
    const f = await setup();
    f.store.enqueue({ ...input, eventId: 'unparsed-write' });
    f.store.update('unparsed-write', 'imported', { actualTransactionId: 'historical-actual-id' });
    f.store.db
      .prepare('UPDATE events SET import_identity_revision=0 WHERE id=?')
      .run('unparsed-write');
    await expect(f.runtime.reconnect()).rejects.toThrow();
    expect(f.runtime.status().ready).toBe(false);
    expect(f.store.get('unparsed-write')).toMatchObject({
      parsed: null,
      actual_transaction_id: 'historical-actual-id',
    });
    expect(f.store.importIdentitiesPrepared()).toBe(false);
  });

  it('does not fabricate fingerprints for never-parsed legacy rows', async () => {
    const f = await setup();
    f.store.enqueue({ ...input, eventId: 'unparsed' });
    f.store.db.prepare('UPDATE events SET import_identity_revision=0 WHERE id=?').run('unparsed');
    await f.runtime.reconnect();
    expect(f.store.get('unparsed')?.parsed).toBeNull();
    expect(f.store.legacyImportEvents()).toEqual([]);
  });
});
