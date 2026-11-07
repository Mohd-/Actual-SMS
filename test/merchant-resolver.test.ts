import { banks, parsing } from './fixtures/banks.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../src/db.js';
import { merchantKey, MerchantResolver } from '../src/merchant-resolver.js';
import type { ActualAdapter, HistoricalTransaction, ResolvedConfig } from '../src/types.js';

const stores: EventStore[] = [];
afterEach(() => {
  stores.splice(0).forEach(store => store.close());
});

const config: ResolvedConfig = {
  banks,
  parsing,
  accounts: [
    {
      key: 'checking',
      id: 'checking-id',
      name: 'Checking',
      match: { bank: 'sab', transactionKinds: ['purchase', 'refund'] },
    },
  ],
  bankFeesCategoryId: 'fees',
  eligibleCategories: [{ id: 'ai-only', name: 'AI only' }],
};

function setup(history: HistoricalTransaction[]) {
  const store = new EventStore(':memory:');
  stores.push(store);
  const actual: ActualAdapter = {
    initialize: async () => {},
    serverVersion: async () => '26.11.0',
    shutdown: async () => {},
    sync: vi.fn(async () => {}),
    accounts: async () => [],
    categories: async () => [
      { id: 'food', name: 'Food' },
      { id: 'shopping', name: 'Shopping' },
      { id: 'hidden', name: 'Hidden', hidden: true },
    ],
    transactions: async () => history,
    transferPayee: async () => '',
    importTransactions: async () => ({ added: [], updated: [], errors: [] }),
  };
  return { store, actual, resolver: new MerchantResolver(store, actual, config, 0.7) };
}

describe('merchant history resolver', () => {
  it('normalizes exact descriptions and accepts active categories outside the AI list', async () => {
    const { resolver } = setup([
      {
        id: 'transaction-1',
        accountId: 'checking-id',
        date: '2026-08-20',
        importedPayee: '  SAMPLE—Books  ',
        payeeName: 'Sample Books',
        categoryId: 'shopping',
      },
    ]);
    await resolver.refresh();

    expect(merchantKey('sample books')).toBe('sample books');
    expect(resolver.lookup('checking-id', 'sample books')).toMatchObject({
      payee: 'Sample Books',
      category_id: 'shopping',
      source: 'actual',
    });
    expect(resolver.lookup('another-account', 'sample books')).toBeUndefined();
  });

  it('makes a newly observed Actual category correction authoritative', async () => {
    const history = [
      {
        id: 'transaction-1',
        accountId: 'checking-id',
        date: '2020-01-01',
        importedPayee: 'Cafe',
        payeeName: 'Cafe',
        categoryId: 'food',
      },
    ];
    const { resolver } = setup(history);
    await resolver.refresh();
    resolver.learnLocal(
      'checking-id',
      'Cafe',
      { payee: 'Cafe', categoryId: 'shopping', confidence: 0.9, reason: 'test' },
      'event-1',
      '2026-01-01T00:00:00.000Z',
    );
    history[0]!.categoryId = 'shopping';
    await resolver.refresh();

    expect(resolver.lookup('checking-id', 'Cafe')?.category_id).toBe('shopping');
    expect(resolver.lookup('checking-id', 'Cafe')?.source).toBe('actual');
  });

  it('ignores hidden categories', async () => {
    const { resolver } = setup([
      {
        id: 'transaction-1',
        accountId: 'checking-id',
        date: '2026-08-20',
        payeeName: 'Hidden merchant',
        categoryId: 'hidden',
      },
    ]);
    await resolver.refresh();
    expect(resolver.lookup('checking-id', 'Hidden merchant')).toBeUndefined();
  });
});
