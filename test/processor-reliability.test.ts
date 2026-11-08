import { afterEach, describe, expect, it, vi } from 'vitest';
import { Settings } from 'luxon';
import { EventStore } from '../src/db.js';
import { Processor } from '../src/processor.js';
import { parseSms } from '../src/parser.js';
import { legacyImportId, migrateImportIdentities } from '../src/import-identity.js';
import type { ActualAdapter, ActualTransaction, ResolvedConfig } from '../src/types.js';
import { banks, parsing } from './fixtures/banks.js';

const stores: EventStore[] = [];
const originalZone = Settings.defaultZone;
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  Settings.defaultZone = originalZone;
});
const config: ResolvedConfig = {
  banks,
  parsing,
  accounts: [
    { key: 'a', id: 'a', name: 'Checking', match: { bank: 'sab', accountSuffixes: ['1234'] } },
    { key: 'b', id: 'b', name: 'Card', match: { bank: 'alrajhi', accountSuffixes: ['5678'] } },
  ],
  bankFeesCategoryId: 'fees',
  eligibleCategories: [],
};
const receivedAt = '2026-08-22T10:10:30+03:00';
const purchase = 'Purchase Card **1234 Amount SAR 25 at Example Store on 2026-08-22 00:30';
const transfer =
  'Outgoing transfer From: 1234 To: 5678 Amount SAR 100 Fees SAR 1 on 2026-08-22 10:05';
const credit = 'Incoming transfer From: 1234 To: 5678 Amount SAR 100 on 2026-08-22 10:05';
const disabled = { enrich: async () => ({ status: 'disabled' as const, durationMs: 0 }) };
function setup() {
  const store = new EventStore(':memory:');
  stores.push(store);
  const ledger = new Map<string, { account: string; transaction: ActualTransaction }>();
  const actual: ActualAdapter = {
    initialize: async () => {},
    serverVersion: async () => '26.11.0',
    shutdown: async () => {},
    sync: vi.fn(async () => {}),
    accounts: async () => [],
    categories: async () => [],
    transactions: async () => [],
    transferPayee: async account => `transfer:${account}`,
    importTransactions: vi.fn(async (account, transactions) => {
      const added: string[] = [],
        updated: string[] = [];
      for (const transaction of transactions) {
        const key = `${account}:${transaction.imported_id}`;
        (ledger.has(key) ? updated : added).push(key);
        ledger.set(key, { account, transaction });
      }
      return { added, updated, errors: [] };
    }),
  };
  return { store, actual, ledger, processor: new Processor(store, actual, disabled, config) };
}
const enqueue = (store: EventStore, id: string, message = purchase, sender = 'SAB') =>
  store.enqueue({ eventId: id, sender, message, receivedAt }).id;
const due = (store: EventStore, id: string) =>
  store.update(id, 'queued', { nextAttemptAt: new Date(0).toISOString() });

describe('accounting reliability', () => {
  it.each(['UTC', 'America/New_York', 'Asia/Tokyo'])(
    'preserves the Riyadh date with host timezone %s',
    async zone => {
      Settings.defaultZone = zone;
      const { store, processor, ledger } = setup();
      enqueue(store, 'midnight');
      await processor.tick();
      expect([...ledger.values()][0]?.transaction.date).toBe('2026-08-22');
    },
  );

  it.each(['external', 'principal', 'fee'])(
    'retries a returned %s import error and keeps the same IDs',
    async part => {
      const { store, processor, actual, ledger } = setup();
      const message = part === 'external' ? transfer.replace('5678', '9999') : transfer;
      enqueue(store, 'debit', message);
      const realImport = actual.importTransactions;
      let failed = false;
      vi.spyOn(actual, 'importTransactions').mockImplementation(async (account, transactions) => {
        const isFee = transactions[0]?.category === 'fees';
        if (!failed && (part !== 'fee' || isFee)) {
          failed = true;
          return { added: [], updated: [], errors: [{ message: 'Synthetic import failure' }] };
        }
        return realImport(account, transactions);
      });
      await processor.tick();
      expect(store.get('debit')).toMatchObject({
        status: 'queued',
        attempts: 1,
        error: 'Synthetic import failure',
      });
      due(store, 'debit');
      await processor.tick();
      expect(store.get('debit')?.status).toBe('imported');
      expect(ledger.size).toBe(part === 'external' ? 1 : 2);
    },
  );

  it.each(['fee', 'sync'])(
    'holds the matching credit while the debit has an incomplete %s',
    async stage => {
      const { store, processor, actual, ledger } = setup();
      if (stage === 'sync')
        vi.spyOn(actual, 'sync').mockRejectedValueOnce(new Error('Synthetic sync failure'));
      else {
        const realImport = actual.importTransactions;
        let failed = false;
        vi.spyOn(actual, 'importTransactions').mockImplementation(async (account, transactions) => {
          if (!failed && transactions[0]?.category === 'fees') {
            failed = true;
            return { added: [], updated: [], errors: [{ message: 'Synthetic fee failure' }] };
          }
          return realImport(account, transactions);
        });
      }
      enqueue(store, 'debit', transfer);
      await processor.tick();
      enqueue(store, 'credit', credit, 'AlRajhiBank');
      await processor.tick();
      expect(store.get('credit')?.status).toBe('queued');
      expect([...ledger.values()].every(entry => entry.account === 'a')).toBe(true);
      due(store, 'debit');
      await processor.tick();
      due(store, 'credit');
      await processor.tick();
      expect(store.get('debit')?.status).toBe('imported');
      expect(store.get('credit')?.status).toBe('imported');
      expect(ledger.size).toBe(2);
    },
  );

  it('preserves an independent-side transfer plan when sync fails and processing restarts', async () => {
    const { store, processor, actual, ledger } = setup();
    enqueue(store, 'credit', credit.replace('From: 1234 ', ''), 'AlRajhiBank');
    await processor.tick();
    vi.spyOn(actual, 'sync').mockRejectedValueOnce(new Error('Synthetic sync failure'));
    enqueue(store, 'debit', transfer);
    await processor.tick();
    due(store, 'debit');
    const restarted = new Processor(store, actual, disabled, config);
    await restarted.tick();
    expect(store.get('debit')?.status).toBe('imported');
    expect(ledger.size).toBe(2);
    expect([...ledger.values()].every(entry => entry.transaction.payee === undefined)).toBe(true);
  });

  it('distinguishes equal purchases in the same bank minute and preserves IDs across restart and retry', async () => {
    const { store, processor, actual, ledger } = setup();
    enqueue(store, 'one');
    enqueue(store, 'two');
    await processor.tick();
    vi.spyOn(actual, 'sync').mockRejectedValueOnce(new Error('Synthetic sync failure'));
    await processor.tick();
    expect(ledger.size).toBe(2);
    const ids = [...ledger.keys()];
    due(store, 'two');
    await new Processor(store, actual, disabled, config).tick();
    expect([...ledger.keys()]).toEqual(ids);
    const result = parseSms(purchase, receivedAt, banks, 'SAB', parsing);
    if (result.type !== 'transaction') throw new Error('Invalid synthetic fixture');
    expect([...ledger.values()][0]?.transaction.imported_id).toBe(
      legacyImportId(result.transaction, 'a'),
    );
  });

  it.each(['imported', 'failed'] as const)(
    'reserves historical IDs during preparation without replaying a pre-upgrade %s event',
    async status => {
      const { store, actual, ledger } = setup();
      enqueue(store, 'old');
      const result = parseSms(purchase, receivedAt, banks, 'SAB', parsing);
      if (result.type !== 'transaction') throw new Error('Invalid synthetic fixture');
      const legacy = legacyImportId(result.transaction, 'a');
      store.update('old', status, { parsed: result.transaction, parserRevision: 14 });
      store.db.prepare('UPDATE events SET import_identity_revision=0 WHERE id=?').run('old');
      migrateImportIdentities(store, config);
      expect(store.reserveImportId('old', 'main', legacy)).toBe(legacy);
      const restarted = new Processor(store, actual, disabled, config);
      enqueue(store, 'new');
      await restarted.tick();
      const latest = [...ledger.values()].at(-1)?.transaction.imported_id;
      expect(latest).not.toBe(legacy);
      expect(ledger.size).toBe(1);
      expect(store.get('old')?.status).toBe(status);
    },
  );
});
