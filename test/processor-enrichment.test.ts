import { banks } from './fixtures/banks.js';
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from '../src/db.js';
import { Processor } from '../src/processor.js';
import type { ActualAdapter, AiSuggestion, Enricher, ResolvedConfig } from '../src/types.js';
import { merchantKey } from '../src/merchant-resolver.js';

const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
});

function setup(suggestion: AiSuggestion | null, shouldThrow = false) {
  const store = new EventStore(':memory:');
  stores.push(store);
  const imported: Parameters<ActualAdapter['importTransactions']>[1] = [];
  const actual: ActualAdapter = {
    initialize: async () => {},
    serverVersion: async () => '26.5.2',
    shutdown: async () => {},
    sync: async () => {},
    accounts: async () => [],
    categories: async () => [],
    transactions: async () => [],
    transferPayee: async () => '',
    importTransactions: async (_account, transactions) => {
      imported.push(...transactions);
      return { added: ['actual-id'], updated: [], errors: [] };
    },
  };
  const enricher: Enricher = {
    enrich: async () => {
      if (shouldThrow) throw new Error('quota exhausted');
      return suggestion
        ? {
            status: 'success',
            suggestion,
            model: 'test',
            durationMs: 1,
            httpStatus: 200,
            response: {},
          }
        : { status: 'disabled', durationMs: 0 };
    },
  };
  const config: ResolvedConfig = {
    banks,
    accounts: [
      {
        key: 'sab-checking',
        id: 'account-id',
        name: 'Card',
        match: { bank: 'sab', accountSuffixes: ['5202'] },
      },
    ],
    bankFeesCategoryId: 'fees',
    eligibleCategories: [{ id: 'shopping', name: 'Shopping' }],
  };
  const { id } = store.enqueue({
    eventId: `event-${Math.random()}`,
    sender: 'SAB',
    message: 'SAB purchase Card **5202 Amount SAR 25.00 at Example Store on 2026-08-22 10:05',
    receivedAt: '2026-08-22T10:10:30+03:00',
  });
  return { store, imported, processor: new Processor(store, actual, enricher, config), id };
}

describe('processor enrichment', () => {
  it('records parser review reasons without retrying or importing', async () => {
    const { store, imported, processor, id } = setup(null);
    store.db.prepare('UPDATE events SET payload=? WHERE id=?').run(
      JSON.stringify({
        eventId: id,
        sender: 'STC Bank',
        message: 'purchase amount SAR 25',
        receivedAt: '2026-08-22T10:10:30+03:00',
      }),
      id,
    );
    await processor.tick();

    expect(imported).toHaveLength(0);
    expect(store.get(id)).toMatchObject({
      status: 'needs_review',
      parser_reason: 'unsupported_sender',
      error: null,
      attempts: 0,
    });
  });

  it.each([
    [0.7, 'shopping'],
    [0.69, undefined],
  ])(
    'applies categories only at the 0.70 threshold (confidence %s)',
    async (confidence, category) => {
      const suggestion = {
        payee: 'Sample Books',
        categoryId: 'shopping',
        confidence,
        reason: 'x',
      };
      const { store, imported, processor, id } = setup(suggestion);
      await processor.tick();

      expect(imported[0]).toMatchObject({ payee_name: 'Sample Books', category });
      expect(JSON.parse(store.get(id)!.suggestion!)).toEqual(suggestion);
    },
  );

  it('imports the unenriched transaction when enrichment fails', async () => {
    const { store, imported, processor, id } = setup(null, true);
    await processor.tick();

    expect(store.get(id)?.status).toBe('imported');
    expect(imported[0]).toMatchObject({ payee_name: 'Example Store', category: undefined });
    expect(store.enrichmentAttempts(id).at(-1)?.status).toBe('llm_network_error');
  });

  it('uses a prior mapping without calling the LLM', async () => {
    const { store, imported, processor, id } = setup(null);
    store.putMapping({
      account_id: 'account-id',
      merchant_key: merchantKey('Example Store'),
      payee: 'Sample Books',
      category_id: 'shopping',
      source: 'actual',
      source_ref: 'actual-old',
      decision_at: '2026-08-01T00:00:00.000Z',
    });
    await processor.tick();

    expect(imported[0]).toMatchObject({ payee_name: 'Sample Books', category: 'shopping' });
    expect(store.enrichmentAttempts(id).at(-1)?.status).toBe('history_hit');
  });
});
