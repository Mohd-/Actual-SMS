import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { EventStore } from '../src/db.js';
import { Processor } from '../src/processor.js';
import { NoopEnricher } from '../src/enricher.js';
import { ConfigEditor } from '../src/config-editor.js';
import { runtimeFixture } from './fixtures/runtime.js';
import type { ActualTransaction } from '../src/types.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const input = {
  eventId: 'purchase',
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
  const ledger = new Map<string, ActualTransaction>();
  const requests: { account: string; transaction: ActualTransaction }[] = [];
  f.actual.accounts = async () => [
    { id: 'checking', name: 'Checking' },
    { id: 'other', name: 'Other' },
  ];
  f.actual.importTransactions = async (account, transactions) => {
    const transaction = transactions[0]!;
    requests.push({ account, transaction: structuredClone(transaction) });
    const key = `${account}:${transaction.imported_id}`;
    const existing = ledger.has(key);
    ledger.set(key, structuredClone(transaction));
    return { added: existing ? [] : [key], updated: existing ? [key] : [], errors: [] };
  };
  const ai = new NoopEnricher();
  const enrich = vi.spyOn(ai, 'enrich');
  return {
    ...f,
    ledger,
    requests,
    enrich,
    get store() {
      return store;
    },
    processor: () =>
      new Processor(store, f.actual, ai, f.config, 5, 0.7, undefined, f.runtime.gate),
    due: () => store.update('purchase', 'queued', { nextAttemptAt: new Date(0).toISOString() }),
    reopen: () => {
      store.close();
      store = new EventStore(path);
      store.recover();
    },
  };
}

describe('durable ordinary import execution', () => {
  it.each([
    'rejection',
    'mixed IDs and errors',
    'lost response before write',
    'lost response after write',
    'deduplication without IDs',
  ])('preserves dispatch across restart after %s', async stage => {
    const f = await setup();
    const write = f.actual.importTransactions;
    let fail = true;
    f.actual.importTransactions = async (account, transactions) => {
      if (fail) {
        fail = false;
        if (stage === 'rejection')
          return { added: [], updated: [], errors: [{ message: 'Rejected' }] };
        if (stage === 'lost response before write') throw new Error('Response lost');
        const result = await write(account, transactions);
        if (stage === 'lost response after write') throw new Error('Response lost');
        if (stage === 'mixed IDs and errors')
          return { ...result, errors: [{ message: 'Partial failure' }] };
        return { added: [], updated: [], errors: [] };
      }
      return write(account, transactions);
    };
    let offline = true;
    f.actual.sync = async () => {
      if (offline) throw new Error('Offline');
    };
    f.store.enqueue(input);
    await f.processor().tick();
    expect(f.store.get('purchase')?.status).toBe('queued');
    if (stage === 'mixed IDs and errors')
      expect(f.store.get('purchase')?.actual_transaction_id).toBeTruthy();
    offline = false;
    const editor = new ConfigEditor(f.runtime, true);
    const current = await editor.read();
    await editor.save(current.accounts.replace('Checking', 'Other'), current.revision);
    f.reopen();
    f.due();
    await f.processor().tick();
    expect(f.store.get('purchase')?.status).toBe('imported');
    expect(f.ledger.size).toBe(1);
    expect(f.requests.every(request => request.account === 'checking')).toBe(true);
    expect(
      f.requests.every(request => JSON.stringify(request) === JSON.stringify(f.requests[0])),
    ).toBe(true);
    if (stage === 'deduplication without IDs') expect(f.requests).toHaveLength(1);
    expect(f.enrich).toHaveBeenCalledTimes(1);
  });

  it('commits identity reservations and dispatch intent atomically before any Actual write', async () => {
    const f = await setup();
    f.store.db.exec(
      "CREATE TRIGGER interrupt_dispatch BEFORE INSERT ON import_executions BEGIN SELECT RAISE(ABORT,'interrupted'); END",
    );
    f.store.enqueue(input);
    await f.processor().tick();
    expect(f.store.get('purchase')?.status).toBe('queued');
    expect(f.requests).toHaveLength(0);
    const historical = 'sms:5398c6b55cd5865a4d0ede31804467e3b58c6e73772a6820a132f58d429db8a1';
    // A different event can still reserve the base ID: the aborted write left no reservation.
    expect(f.store.reserveImportId('probe', 'main', historical)).toBe(historical);
    f.store.db.exec('DROP TRIGGER interrupt_dispatch');
    f.due();
    await f.processor().tick();
    expect(f.store.get('purchase')?.status).toBe('imported');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.transaction.imported_id).not.toBe(historical);
  });

  it('holds a historical ordinary write without a frozen plan even if no Actual ID was returned', async () => {
    const f = await setup();
    f.actual.importTransactions = async () => {
      throw new Error('Response lost');
    };
    f.store.enqueue(input);
    await f.processor().tick();
    expect(f.store.get('purchase')?.actual_transaction_id).toBeNull();
    f.store.db.exec(
      "DROP TABLE import_executions; DELETE FROM service_migrations WHERE key='import-execution:1'",
    );
    f.reopen();
    f.actual.importTransactions = vi.fn(async () => ({ added: [], updated: [], errors: [] }));
    f.due();
    await f.processor().tick();
    expect(f.store.get('purchase')).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('reconciliation'),
    });
    expect(f.actual.importTransactions).not.toHaveBeenCalled();
  });

  it('does not recalculate a foreign amount or enrich again after freezing the write', async () => {
    const f = await setup();
    const previous = vi.spyOn(f.store, 'previousBalance').mockReturnValue(20_000);
    f.actual.sync = async () => {
      throw new Error('Offline');
    };
    f.store.enqueue({
      ...input,
      message: 'SAB Purchase Card:1234 Amount USD 10.00 at Coffee Balance SAR 150.00',
    });
    await f.processor().tick();
    expect(f.store.get('purchase')?.status).toBe('queued');
    expect(previous).toHaveBeenCalledTimes(1);
    previous.mockReturnValue(99_000);
    f.actual.sync = async () => {};
    f.due();
    await f.processor().tick();
    expect(f.store.get('purchase')?.status).toBe('imported');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.transaction.amount).toBe(-5000);
    expect(previous).toHaveBeenCalledTimes(1);
    expect(f.enrich).toHaveBeenCalledTimes(1);
  });

  it('resumes the frozen account and payload after sync failure, YAML activation, and restart', async () => {
    const f = await setup();
    let failed = false;
    f.actual.sync = async () => {
      if (!failed) {
        failed = true;
        throw new Error('Sync failed');
      }
    };
    f.store.enqueue(input);
    await f.processor().tick();
    expect(f.store.get('purchase')?.status).toBe('queued');
    const editor = new ConfigEditor(f.runtime, true);
    const current = await editor.read();
    await editor.save(current.accounts.replace('Checking', 'Other'), current.revision);
    f.reopen();
    f.due();
    await f.processor().tick();
    expect(f.store.get('purchase')?.status).toBe('imported');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.account).toBe('checking');
    expect(f.ledger.size).toBe(1);
    expect(f.enrich).toHaveBeenCalledTimes(1);
  });
});
