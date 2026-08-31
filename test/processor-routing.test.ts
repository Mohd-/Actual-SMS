import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from '../src/db.js';
import { PARSER_REVISION } from '../src/parser.js';
import { Processor } from '../src/processor.js';
import type { ActualAdapter, Enricher, ResolvedConfig } from '../src/types.js';

const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
});

const config: ResolvedConfig = {
  accounts: [
    {
      key: 'sab-checking',
      id: 'sab-checking-id',
      name: 'SampleLedger1',
      match: { bank: 'sab', accountSuffixes: ['4101', '101', '4187'] },
    },
    {
      key: 'payroll',
      id: 'payroll-id',
      name: 'SampleLedger2',
      match: { bank: 'sab', accountSuffixes: ['5202', '202'] },
    },
    {
      key: 'alrajhi-checking',
      id: 'alrajhi-checking-id',
      name: 'Alrajhi Checking',
      match: { bank: 'alrajhi', hasBalance: false, transferIdentifiers: ['7404'] },
    },
    {
      key: 'credit-card',
      id: 'credit-card-id',
      name: 'SampleLedger4',
      match: { bank: 'alrajhi', hasBalance: true, billPaymentIdentifiers: ['404'] },
    },
  ],
  bankFeesCategoryId: 'fees',
  eligibleCategories: [],
};

function setup() {
  const store = new EventStore(':memory:');
  stores.push(store);
  const imported: {
    account: string;
    transactions: Parameters<ActualAdapter['importTransactions']>[1];
  }[] = [];
  const transferPayees: string[] = [];
  const actual: ActualAdapter = {
    initialize: async () => {},
    serverVersion: async () => '26.5.2',
    shutdown: async () => {},
    sync: async () => {},
    accounts: async () => [],
    categories: async () => [],
    transactions: async () => [],
    transferPayee: async accountId => {
      transferPayees.push(accountId);
      return `transfer:${accountId}`;
    },
    importTransactions: async (account, transactions) => {
      imported.push({ account, transactions });
      return { added: ['actual-id'], updated: [], errors: [] };
    },
  };
  const ai: Enricher = { enrich: async () => ({ status: 'disabled', durationMs: 0 }) };
  return {
    store,
    imported,
    transferPayees,
    processor: new Processor(store, actual, ai, config),
  };
}

const outgoing = 'SAB SARIE transfer accepted From: 5202 To: SA0000000000007404 Amount: SAR 100.00';
const incoming = 'Al Rajhi SARIE transfer credited From: 5202 To: 7404 Amount: SAR 100.00';
const outgoingWithAccountAliases =
  'SAB outgoing transfer Account **5202 Beneficiary Account **7404 Amount: SAR 100.00';
const outgoingToBillerCode = 'SAB SARIE transfer accepted From: 5202 To: 404 Amount: SAR 100.00';
const outgoingIbanEndingInBillerCode =
  'SAB SARIE transfer accepted From: 5202 IBAN: SA0000000000000404 Amount: SAR 100.00';
const cardPaymentToBillerCode = 'SAB card payment From: 5202 To: 404 Amount: SAR 100.00';
const cardPaymentIbanEndingInBillerCode =
  'SAB card payment From: 5202 IBAN: SA0000000000000404 Amount: SAR 100.00';
const receivedAt = '2026-08-22T10:10:30+03:00';

describe('processor transfer routing', () => {
  it('imports a salary transfer into the account named by its To field', async () => {
    const { store, imported, processor } = setup();
    const id = store.enqueue({
      eventId: 'salary-to-payroll',
      sender: 'SAB',
      message: 'حوالة راتب\nإلى: **202\nمبلغ: 25,559.77 SAR\nفي: 2026-08-26 08:02:50',
      receivedAt: '2026-08-26T05:04:03.897Z',
    }).id;

    await processor.tick();

    expect(store.get(id)?.status).toBe('imported');
    expect(imported).toEqual([
      {
        account: 'payroll-id',
        transactions: [expect.objectContaining({ amount: 2555977, payee_name: 'Bank transfer' })],
      },
    ]);
  });

  it('routes an outgoing transfer using its beneficiary account suffix', async () => {
    const { store, imported, processor, transferPayees } = setup();
    store.enqueue({
      eventId: 'beneficiary-account-suffix',
      sender: 'SAB',
      message: outgoingWithAccountAliases,
      receivedAt,
    });

    await processor.tick();

    expect(transferPayees).toEqual(['alrajhi-checking-id']);
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      account: 'payroll-id',
      transactions: [{ payee: 'transfer:alrajhi-checking-id', amount: -10000 }],
    });
  });

  it('imports an Al Rajhi card bill from SampleLedger2 to the SampleLedger4 account', async () => {
    const { store, imported, processor, transferPayees } = setup();
    store.enqueue({
      eventId: 'alrajhi-card-bill',
      sender: 'SAB',
      message:
        'سداد فاتورة\nمن: ***202\nمفوتر: 404 بنك الراجحي البطاقة اﻻئتمانيه \nلخدمة: POSTPAID\nرقم الفاتورة: 111817823 \nمبلغ: 9,145.00 SAR\nفي: 2026-08-26 08:43:27',
      receivedAt: '2026-08-26T05:44:04.596Z',
    });

    await processor.tick();

    expect(transferPayees).toEqual(['credit-card-id']);
    expect(imported).toEqual([
      {
        account: 'payroll-id',
        transactions: [
          expect.objectContaining({ amount: -914500, payee: 'transfer:credit-card-id' }),
        ],
      },
    ]);
  });

  it.each([
    ['transfer To field', outgoingToBillerCode],
    ['transfer IBAN', outgoingIbanEndingInBillerCode],
    ['card-payment To field', cardPaymentToBillerCode],
    ['card-payment IBAN', cardPaymentIbanEndingInBillerCode],
  ])(
    'keeps an ordinary transaction with biller code 404 in %s external',
    async (field, message) => {
      const { store, imported, processor, transferPayees } = setup();
      store.enqueue({ eventId: `ordinary-404-${field}`, sender: 'SAB', message, receivedAt });

      await processor.tick();

      expect(transferPayees).toEqual([]);
      expect(imported).toEqual([
        {
          account: 'payroll-id',
          transactions: [expect.objectContaining({ amount: -10000, payee_name: 'Bank transfer' })],
        },
      ]);
    },
  );

  it('replays a previously ignored SARIE transfer once and imports it once', async () => {
    const { store, imported, processor } = setup();
    const id = store.enqueue({
      eventId: 'previously-ignored',
      sender: 'SAB',
      message: outgoing,
      receivedAt,
    }).id;
    store.update(id, 'ignored', {
      parserReason: 'unrecognized_template',
      parserRevision: 1,
    });

    expect(store.replayParserRevision(PARSER_REVISION)).toBe(1);
    await processor.tick();

    expect(store.get(id)?.status).toBe('imported');
    expect(imported).toHaveLength(1);
    expect(imported[0]?.transactions).toHaveLength(1);
    expect(store.replayParserRevision(PARSER_REVISION)).toBe(0);
    await processor.tick();
    expect(imported).toHaveLength(1);
  });

  it.each([
    [outgoing, incoming, 'alrajhi-checking-id'],
    [incoming, outgoing, 'payroll-id'],
  ])(
    'pairs cross-bank transfers in either message order',
    async (first, second, targetAccountId) => {
      const { store, imported, processor, transferPayees } = setup();
      const firstEvent = store.enqueue({
        eventId: 'first',
        sender: first.includes('SAB') ? 'SAB' : 'AlrajhiBank',
        message: first,
        receivedAt,
      }).id;
      const secondEvent = store.enqueue({
        eventId: 'second',
        sender: second.includes('SAB') ? 'SAB' : 'AlrajhiBank',
        message: second,
        receivedAt,
      }).id;

      await processor.tick();
      await processor.tick();

      expect(transferPayees).toEqual([targetAccountId]);
      expect(imported).toHaveLength(1);
      expect(imported[0]?.transactions[0]).toMatchObject({ payee: `transfer:${targetAccountId}` });
      expect(store.get(firstEvent)?.status).toBe('imported');
      expect(store.get(secondEvent)?.status).toBe('imported');
    },
  );

  it('keeps the historical imported ID suffix and distinguishes source identifiers', async () => {
    const { store, imported, processor } = setup();
    const message =
      'SAB purchase Card **4101 Amount SAR 25.00 at Example Store on 2026-08-22 10:05';
    const alternate = message.replace('4101', '4187');
    store.enqueue({ eventId: 'one', sender: 'SAB', message, receivedAt });
    store.enqueue({ eventId: 'two', sender: 'SAB', message: alternate, receivedAt });

    await processor.tick();
    await processor.tick();

    const expected =
      'sms:' +
      createHash('sha256')
        .update(
          [
            'sab',
            '4101',
            'purchase',
            '2026-08-22T10:05:00.000+03:00',
            -2500,
            'Example Store',
            'main',
          ].join('|'),
        )
        .digest('hex');
    const ids = imported.flatMap(entry =>
      entry.transactions.map(transaction => transaction.imported_id),
    );
    expect(ids).toContain(expected);
    expect(new Set(ids)).toHaveLength(2);
  });
});
