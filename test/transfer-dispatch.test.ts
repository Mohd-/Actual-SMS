import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { ConfigEditor } from '../src/config-editor.js';
import { EventStore } from '../src/db.js';
import { Processor } from '../src/processor.js';
import { NoopEnricher } from '../src/enricher.js';
import { runtimeFixture } from './fixtures/runtime.js';
import type { ActualTransaction } from '../src/types.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const receivedAt = '2026-08-22T10:10:30+03:00';
const outgoing =
  'SAB SARIE transfer accepted From: 1234 To: 7404 Amount: SAR 100.00 Fees: SAR 2.00';
const incoming = 'Al Rajhi SARIE transfer credited From: 1234 To: 7404 Amount: SAR 100.00';
async function setup() {
  const f = await runtimeFixture();
  cleanup.push(f.cleanup);
  f.config.accounts.push({
    key: 'target',
    id: 'target',
    name: 'Target',
    match: { bank: 'alrajhi', hasBalance: false, transferIdentifiers: ['7404'] },
  });
  const path = join(f.directory, 'queue.sqlite');
  let store = new EventStore(path);
  cleanup.push(async () => {
    store.close();
  });
  const ledger = new Map<string, { account: string; amount: number; category?: string }>();
  const requests: { account: string; transaction: ActualTransaction }[] = [];
  let rejectFee = true;
  f.actual.transferPayee = async account => `transfer:${account}`;
  f.actual.importTransactions = async (account, transactions) => {
    const added: string[] = [],
      updated: string[] = [];
    for (const transaction of transactions) {
      requests.push({ account, transaction: structuredClone(transaction) });
      if (rejectFee && transaction.category === 'fees')
        return { added: [], updated: [], errors: [{ message: 'Fee rejected' }] };
      const key = `${account}:${transaction.imported_id}`;
      (ledger.has(key) ? updated : added).push(key);
      ledger.set(key, { account, amount: transaction.amount, category: transaction.category });
      if (transaction.payee?.startsWith('transfer:'))
        ledger.set(`${key}:linked`, {
          account: transaction.payee.slice('transfer:'.length),
          amount: -transaction.amount,
        });
    }
    return { added, updated, errors: [] };
  };
  const processor = (maxAttempts = 5) =>
    new Processor(
      store,
      f.actual,
      new NoopEnricher(),
      f.config,
      maxAttempts,
      0.7,
      undefined,
      f.runtime.gate,
    );
  const enqueue = (id: string, message = outgoing, sender = 'SAB') =>
    store.enqueue({ eventId: id, sender, message, receivedAt });
  const due = (id: string) =>
    store.update(id, 'queued', { nextAttemptAt: new Date(0).toISOString() });
  return {
    ...f,
    get store() {
      return store;
    },
    ledger,
    requests,
    processor,
    enqueue,
    due,
    allowFee: () => {
      rejectFee = false;
    },
    reopen: () => {
      store.close();
      store = new EventStore(path);
      store.recover();
    },
  };
}

describe('durable transfer execution', () => {
  it.each([
    ['debit', 'source'],
    ['debit', 'target'],
    ['debit', 'remove source'],
    ['debit', 'remove target'],
    ['credit', 'source'],
    ['credit', 'target'],
    ['credit', 'remove source'],
    ['credit', 'remove target'],
  ])(
    'recognizes the frozen counterpart after %s first and a %s routing edit',
    async (first, edit) => {
      const f = await setup();
      f.allowFee();
      f.actual.accounts = async () => [
        { id: 'checking', name: 'Checking' },
        { id: 'other', name: 'Other' },
        { id: 'target', name: 'Target' },
        { id: 'other-target', name: 'Other Target' },
      ];
      await writeFile(
        f.paths.accounts,
        `accounts:
  - actualName: Checking
    match:
      bank: sab
      accountSuffixes: ['1234']
  - actualName: Target
    match:
      bank: alrajhi
      hasBalance: false
      transferIdentifiers: ['7404']
bankFeesCategory: Fees
`,
      );
      await f.runtime.reconnect();
      let fail = true;
      f.actual.sync = async () => {
        if (fail) {
          fail = false;
          throw new Error('Sync failed');
        }
      };
      if (first === 'debit') f.enqueue('debit');
      else f.enqueue('credit', incoming, 'AlRajhiBank');
      await f.processor().tick();
      expect(f.store.get(first)?.status).toBe('queued');
      const editor = new ConfigEditor(f.runtime, true);
      const current = await editor.read();
      const candidate =
        edit === 'source'
          ? current.accounts.replace('Checking', 'Other')
          : edit === 'target'
            ? current.accounts.replace('Target', 'Other Target')
            : edit === 'remove source'
              ? current.accounts.replace(
                  / {2}- actualName: Checking[\s\S]*?(?= {2}- actualName: Target)/,
                  '',
                )
              : current.accounts.replace(
                  / {2}- actualName: Target[\s\S]*?(?=bankFeesCategory)/,
                  '',
                );
      await editor.save(candidate, current.revision);
      f.reopen();
      f.due(first!);
      await f.processor().tick();
      if (first === 'debit') f.enqueue('credit', incoming, 'AlRajhiBank');
      else f.enqueue('debit');
      await f.processor().tick();
      expect(f.store.get('credit')?.status).toBe('imported');
      expect(f.store.get('debit')?.status).toBe('imported');
      expect(f.requests).toHaveLength(2);
      expect(f.ledger.size).toBe(3);
    },
  );

  it('holds multiple plausible counterparts instead of choosing the nearest and writing another principal', async () => {
    const f = await setup();
    f.allowFee();
    f.enqueue('debit-one');
    await f.processor().tick();
    f.enqueue('debit-two');
    await f.processor().tick();
    const count = f.requests.length;
    f.enqueue('credit', incoming, 'AlRajhiBank');
    await f.processor().tick();
    expect(f.store.get('credit')).toMatchObject({
      status: 'failed',
      attempts: 0,
      error: expect.stringContaining('ambiguous'),
    });
    expect(f.requests).toHaveLength(count);
  });

  it.each(['1234', '7404'])(
    'holds inconsistent endpoint %s rather than guessing from a broad bank route',
    async endpoint => {
      const f = await setup();
      f.allowFee();
      f.enqueue('debit');
      await f.processor().tick();
      f.enqueue('credit', incoming.replace(endpoint, '9999'), 'AlRajhiBank');
      await f.processor().tick();
      expect(f.store.get('credit')).toMatchObject({
        status: 'failed',
        attempts: 0,
        error: expect.stringContaining('reconciliation'),
      });
      expect(f.requests).toHaveLength(2);
      expect(f.ledger.size).toBe(3);
    },
  );

  it('migrates frozen transfer progress into the single import execution authority', async () => {
    const f = await setup();
    f.enqueue('debit');
    await f.processor().tick();
    f.store.db
      .exec(`INSERT INTO transfer_executions(event_id,plan,principal_done,fee_done,complete,principal_actual_id,fee_actual_id)
      SELECT event_id,json_remove(plan,'$.version','$.kind','$.endpoints'),principal_done,fee_done,complete,principal_actual_id,fee_actual_id FROM import_executions;
      DROP TABLE import_executions; DELETE FROM service_migrations WHERE key='import-execution:1';`);
    f.reopen();
    // This old table is no longer consulted for dispatch or progress.
    f.store.db.exec('DELETE FROM transfer_executions');
    f.config.accounts[0]!.id = 'replacement';
    f.config.bankFeesCategoryId = 'replacement-fees';
    f.allowFee();
    f.due('debit');
    await f.processor().tick();
    expect(f.store.get('debit')?.status).toBe('imported');
    expect(f.requests.filter(request => request.transaction.amount === -10000)).toHaveLength(1);
    expect(f.requests.at(-1)?.account).toBe('checking');
    expect(f.requests.at(-1)?.transaction.category).toBe('fees');
    expect(f.ledger.size).toBe(3);
    f.reopen();
    f.enqueue('credit', incoming, 'AlRajhiBank');
    await f.processor().tick();
    // The old execution lacks endpoint evidence: hold, never infer a fresh dispatch.
    expect(f.store.get('credit')?.status).toBe('failed');
    expect(f.ledger.size).toBe(3);
  });

  it('preserves completed imports and existing state when adding execution storage', async () => {
    const f = await setup();
    f.allowFee();
    f.enqueue('debit');
    await f.processor().tick();
    const imported = f.store.get('debit'),
      history = f.store.eventHistory('debit');
    const checkpoint = f.store.startInboxSync();
    f.store.db.exec(
      "DROP TABLE transfer_executions; DROP TABLE import_executions; DELETE FROM service_migrations WHERE key IN ('transfer-execution:1','import-execution:1')",
    );
    f.reopen();
    await f.processor().tick();
    expect(f.store.get('debit')).toEqual(imported);
    expect(f.store.eventHistory('debit')).toEqual(history);
    expect(f.store.inboxCheckpoint()).toEqual(checkpoint);
    expect(f.requests).toHaveLength(2);
    expect(f.ledger.size).toBe(3);
    f.reopen();
    await f.processor().tick();
    expect(f.store.get('debit')?.status).toBe('imported');
    expect(f.requests).toHaveLength(2);
  });
  it('holds uncertain pre-upgrade transfers without replaying them or writing their counterparts', async () => {
    const f = await setup();
    f.enqueue('debit');
    await f.processor().tick();
    // Represent the old schema: partial principal evidence, but no frozen dispatch or reservation.
    f.store.db.exec(
      "DROP TABLE transfer_executions; DROP TABLE import_executions; DELETE FROM transfers; DELETE FROM service_migrations WHERE key IN ('transfer-execution:1','import-execution:1')",
    );
    f.reopen();
    expect(f.store.get('debit')).toMatchObject({
      status: 'failed',
      actual_transaction_id: expect.any(String),
      error: expect.stringContaining('reconciliation'),
    });
    f.allowFee();
    f.due('debit');
    await f.processor().tick();
    expect(f.store.get('debit')?.status).toBe('failed');
    f.enqueue('credit', incoming, 'AlRajhiBank');
    await f.processor().tick();
    expect(f.store.get('credit')).toMatchObject({
      status: 'failed',
      attempts: 0,
      error: expect.stringContaining('debit'),
    });
    expect(f.ledger.size).toBe(2);
  });

  it('accepts deduplicated results with no returned IDs and does not reissue writes after a sync failure', async () => {
    const f = await setup();
    f.allowFee();
    const write = f.actual.importTransactions;
    f.actual.importTransactions = async (account, transactions) => {
      await write(account, transactions);
      return { added: [], updated: [], errors: [] };
    };
    let fail = true;
    f.actual.sync = async () => {
      if (fail) {
        fail = false;
        throw new Error('Sync failed');
      }
    };
    f.enqueue('debit');
    await f.processor().tick();
    expect(f.store.get('debit')?.status).toBe('queued');
    f.reopen();
    f.due('debit');
    await f.processor().tick();
    expect(f.store.get('debit')?.status).toBe('imported');
    expect(f.requests).toHaveLength(2);
    expect(f.ledger.size).toBe(3);
  });
  it.each([
    'principal rejection',
    'principal partial',
    'fee partial',
    'lost response before write',
    'lost response after write',
    'sync failure',
  ])('recovers %s across restart without duplicate ledger effects', async stage => {
    const f = await setup();
    f.allowFee();
    const write = f.actual.importTransactions;
    let fail = true;
    f.actual.importTransactions = async (account, transactions) => {
      const isFee = transactions[0]?.category === 'fees';
      if (fail && (stage === 'fee partial' ? isFee : !isFee) && stage !== 'sync failure') {
        fail = false;
        if (stage === 'lost response before write') throw new Error('Response lost');
        if (stage === 'principal rejection')
          return { added: [], updated: [], errors: [{ message: 'Rejected' }] };
        const result = await write(account, transactions);
        if (stage === 'lost response after write') throw new Error('Response lost');
        return { ...result, errors: [{ message: 'Partial failure' }] };
      }
      return write(account, transactions);
    };
    f.actual.sync = async () => {
      if (stage === 'sync failure' && fail) {
        fail = false;
        throw new Error('Sync failed');
      }
    };
    f.enqueue('debit');
    await f.processor().tick();
    expect(f.store.get('debit')?.status).toBe('queued');
    if (stage === 'principal partial')
      expect(f.store.get('debit')?.actual_transaction_id).toBeTruthy();
    if (stage === 'fee partial') expect(f.store.importExecution('debit')?.feeActualId).toBeTruthy();
    f.reopen();
    f.enqueue('credit', incoming, 'AlRajhiBank');
    await f.processor().tick();
    expect(f.store.get('credit')).toMatchObject({ status: 'queued', attempts: 0 });
    f.due('debit');
    await f.processor().tick();
    f.due('credit');
    await f.processor().tick();
    expect(f.store.get('debit')?.status).toBe('imported');
    expect(f.store.get('credit')?.status).toBe('imported');
    expect(f.ledger.size).toBe(3);
    expect([...f.ledger.values()].filter(entry => entry.category === 'fees')).toEqual([
      { account: 'checking', amount: -200, category: 'fees' },
    ]);
    const byId = new Map<string, typeof f.requests>();
    for (const request of f.requests) {
      const id = request.transaction.imported_id;
      byId.set(id, [...(byId.get(id) ?? []), request]);
    }
    expect(byId.size).toBe(2);
    for (const requests of byId.values())
      expect(
        requests.every(request => JSON.stringify(request) === JSON.stringify(requests[0])),
      ).toBe(true);
  });

  it('imports the debit fee even when the linked credit arrived first', async () => {
    const f = await setup();
    f.enqueue('credit', incoming, 'AlRajhiBank');
    await f.processor().tick();
    f.enqueue('debit');
    await f.processor().tick();
    expect(f.store.get('debit')?.status).toBe('queued');
    f.reopen();
    f.allowFee();
    f.due('debit');
    await f.processor().tick();
    expect(f.store.get('debit')?.status).toBe('imported');
    expect(f.ledger.size).toBe(3);
    expect([...f.ledger.values()].filter(entry => entry.category === 'fees')).toEqual([
      { account: 'checking', amount: -200, category: 'fees' },
    ]);
  });

  it('fails a dependent counterpart visibly when its owner exhausts retries', async () => {
    const f = await setup();
    f.enqueue('debit');
    await f.processor(1).tick();
    expect(f.store.get('debit')?.status).toBe('failed');
    f.enqueue('credit', incoming, 'AlRajhiBank');
    await f.processor().tick();
    expect(f.store.get('credit')).toMatchObject({
      status: 'failed',
      attempts: 0,
      error: expect.stringContaining('debit'),
    });
    expect(f.ledger.size).toBe(2);
  });

  it('does not hold an unrelated same-amount transfer', async () => {
    const f = await setup();
    f.enqueue('debit');
    await f.processor().tick();
    f.config.accounts.push({
      key: 'other',
      id: 'other',
      name: 'Other',
      match: { bank: 'sab', accountSuffixes: ['9999'] },
    });
    f.enqueue('other-credit', 'SAB incoming transfer From: 8888 To: 9999 Amount: SAR 100.00');
    await f.processor().tick();
    expect(f.store.get('other-credit')?.status).toBe('imported');
    expect(f.ledger.size).toBe(3);
  });
  it('resumes the frozen account and fee plan after restart and routing edits', async () => {
    const f = await setup();
    f.enqueue('debit');
    await f.processor().tick();
    const principal = f.requests[0]!;
    f.config.accounts[0]!.id = 'replacement';
    f.config.accounts[0]!.key = 'replacement';
    f.config.bankFeesCategoryId = 'new-fees';
    f.reopen();
    f.allowFee();
    f.due('debit');
    await f.processor().tick();
    expect(f.store.get('debit')?.status).toBe('imported');
    expect([...f.ledger.values()]).toEqual([
      { account: 'checking', amount: -10000, category: undefined },
      { account: 'target', amount: 10000 },
      { account: 'checking', amount: -200, category: 'fees' },
    ]);
    expect(
      f.requests.filter(
        request => request.transaction.imported_id === principal.transaction.imported_id,
      ),
    ).toHaveLength(1);
    expect(f.requests.at(-1)?.transaction).toEqual(f.requests[1]?.transaction);
  });
  it('defers a counterpart without consuming attempts and resumes the outstanding fee', async () => {
    const f = await setup(),
      processor = f.processor();
    f.enqueue('debit');
    await processor.tick();
    f.enqueue('credit', incoming, 'AlRajhiBank');
    await processor.tick();
    expect(f.store.get('credit')).toMatchObject({ status: 'queued', attempts: 0 });
    expect(f.ledger.size).toBe(2);
    f.allowFee();
    f.due('debit');
    await processor.tick();
    f.due('credit');
    await processor.tick();
    expect(f.store.get('debit')?.status).toBe('imported');
    expect(f.store.get('credit')?.status).toBe('imported');
    expect([...f.ledger.values()]).toEqual([
      { account: 'checking', amount: -10000, category: undefined },
      { account: 'target', amount: 10000 },
      { account: 'checking', amount: -200, category: 'fees' },
    ]);
  });
});
