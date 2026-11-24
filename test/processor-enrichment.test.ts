import { banks, parsing } from './fixtures/banks.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    serverVersion: async () => '26.11.0',
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
    enrich: vi.fn<Enricher['enrich']>(async () => {
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
    }),
  };
  const config: ResolvedConfig = {
    banks,
    parsing,
    accounts: [
      {
        key: 'sab-checking',
        id: 'account-id',
        name: 'Card',
        match: { bank: 'sab', accountSuffixes: ['5202'] },
      },
    ],
    bankFeesCategoryId: 'fees',
    expenseCategories: [{ id: 'shopping', name: 'Shopping' }],
    eligibleCategories: [{ id: 'shopping', name: 'Shopping' }],
  };
  const { id } = store.enqueue({
    eventId: `event-${Math.random()}`,
    sender: 'SAB',
    message: 'SAB purchase Card **5202 Amount SAR 25.00 at Example Store on 2026-08-22 10:05',
    receivedAt: '2026-08-22T10:10:30+03:00',
  });
  return {
    store,
    imported,
    enricher,
    processor: new Processor(store, actual, enricher, config),
    id,
  };
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

  it.each([0.7, 0.69])('stores a pending suggestion at confidence %s', async confidence => {
    const suggestion = { payee: 'Sample Books', categoryId: 'shopping', confidence, reason: 'x' };
    const { store, imported, processor, id } = setup(suggestion);
    const next = () =>
      store.enqueue({
        eventId: `event-${Math.random()}`,
        sender: 'SAB',
        message: `SAB purchase Card **5202 Amount SAR ${26 + imported.length}.00 at Example Store on 2026-08-22 10:05`,
        receivedAt: '2026-08-22T10:10:30+03:00',
      }).id;
    await processor.tick();

    expect(imported[0]).toMatchObject({
      payee_name: 'Example Store',
      preservePendingAssignment: true,
    });
    expect(imported[0]?.category).toBeUndefined();
    const assignment = store.merchantAssignments.get('account-id', 'example store')!;
    expect(assignment).toMatchObject({
      ...suggestion,
      status: 'pending',
      source: 'ai',
      sourceRef: id,
    });
    const pending = next();
    await processor.tick();
    expect(imported[1]?.category).toBeUndefined();
    expect(store.enrichmentAttempts(pending).map(attempt => attempt.status)).toEqual([
      'merchant_assignment_pending',
    ]);

    store.merchantAssignments.save(
      {
        accountId: assignment.accountId,
        merchant: assignment.merchant,
        payee: assignment.payee,
        categoryId: assignment.categoryId,
      },
      assignment.revision,
    );
    next();
    await processor.tick();
    expect(imported[2]).toMatchObject({ payee_name: 'Sample Books', category: 'shopping' });
  });

  it('imports the unenriched transaction when enrichment fails', async () => {
    const { store, imported, processor, id } = setup(null, true);
    await processor.tick();

    expect(store.get(id)?.status).toBe('imported');
    expect(imported[0]).toMatchObject({ payee_name: 'Example Store' });
    expect(imported[0]?.category).toBeUndefined();
    expect(store.enrichmentAttempts(id).at(-1)?.status).toBe('llm_network_error');
  });

  it('replaces unusable historical assignments with pending suggestions', async () => {
    const suggestion = {
      payee: 'New name',
      categoryId: 'shopping',
      confidence: 0.9,
      reason: 'test',
    };
    const { store, imported, processor, id } = setup(suggestion);
    store.putMapping({
      account_id: 'account-id',
      merchant_key: 'example store',
      payee: 'Old name',
      category_id: 'inactive',
      source: 'local',
      source_ref: 'old-event',
      decision_at: '2026-08-01T00:00:00.000Z',
    });

    await processor.tick();

    expect(store.merchantAssignments.get('account-id', 'example store')).toMatchObject({
      payee: 'New name',
      categoryId: 'shopping',
      status: 'pending',
      sourceRef: id,
    });
    expect(imported[0]).toMatchObject({
      payee_name: 'Example Store',
      preservePendingAssignment: true,
    });
    expect(imported[0]?.category).toBeUndefined();
  });

  it.each(['approve', 'delete'] as const)(
    'keeps a concurrent console decision to %s',
    async decision => {
      const { store, imported, processor, enricher } = setup(null);
      const input = {
        accountId: 'account-id',
        merchant: 'example store',
        payee: 'Console name',
        categoryId: 'shopping',
      };
      store.putMapping({
        account_id: input.accountId,
        merchant_key: input.merchant,
        payee: 'Old name',
        category_id: 'inactive',
        source: 'actual',
        source_ref: 'old-transaction',
        decision_at: '2026-08-01T00:00:00.000Z',
      });
      const stale = store.merchantAssignments.get(input.accountId, input.merchant)!;
      vi.mocked(enricher.enrich).mockImplementationOnce(async () => {
        store.merchantAssignments.save(input, stale.revision);
        if (decision === 'delete') {
          const assignment = store.merchantAssignments.get(input.accountId, input.merchant)!;
          store.merchantAssignments.delete(input.accountId, input.merchant, assignment.revision);
        }
        return {
          status: 'success',
          suggestion: { payee: 'AI name', categoryId: 'shopping', confidence: 0.9, reason: 'test' },
          durationMs: 1,
          model: 'test',
          httpStatus: 200,
          response: {},
        };
      });
      await processor.tick();

      expect(store.merchantAssignments.get(input.accountId, input.merchant)?.status).toBe(
        decision === 'approve' ? 'approved' : 'deleted',
      );
      expect(imported[0]?.payee_name).toBe(
        decision === 'approve' ? 'Console name' : 'Example Store',
      );
    },
  );

  it('keeps an operator-approved assignment visible when its category becomes inactive', async () => {
    const { store, imported, processor, enricher } = setup(null);
    store.merchantAssignments.save(
      {
        accountId: 'account-id',
        merchant: 'example store',
        payee: 'Console name',
        categoryId: 'inactive',
      },
      null,
    );

    await processor.tick();

    expect(enricher.enrich).not.toHaveBeenCalled();
    expect(store.merchantAssignments.get('account-id', 'example store')?.status).toBe('approved');
    expect(imported[0]).toMatchObject({ payee_name: 'Example Store' });
    expect(imported[0]?.category).toBeUndefined();
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
