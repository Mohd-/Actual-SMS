import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../src/db.js';
import { Processor } from '../src/processor.js';
import { PayeeConflict, type PayeeCatalog } from '../src/payees.js';
import { runtimeFixture } from './fixtures/runtime.js';

const stores: EventStore[] = [];
const catalog: PayeeCatalog = {
  payees: [
    { id: 'coffee', name: 'Coffee Co' },
    { id: 'books', name: 'Books' },
    { id: 'transfer', name: 'Transfer', transferAccountId: 'checking' },
  ],
  categories: [
    { id: 'food', name: 'Food' },
    { id: 'other', name: 'Other' },
  ],
  tags: [
    { id: 'work', name: 'Work' },
    { id: 'hidden', name: 'hidden', hidden: true },
  ],
};
const payload = {
  sender: 'SAB',
  message: 'Purchase Card:1234 Amount: SAR 10 at COFFEE-CO',
  receivedAt: '2026-08-22T10:00:00+03:00',
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function open() {
  const store = new EventStore(':memory:');
  stores.push(store);
  return store;
}
function legacy(store: EventStore) {
  store.db.exec(`
    CREATE TABLE merchant_assignment_reviews (accountId TEXT, merchant TEXT, payee TEXT, categoryId TEXT, status TEXT, sourceRef TEXT);
    CREATE TABLE merchant_mappings (merchant_key TEXT);
    CREATE TABLE actual_mapping_observations (merchant_key TEXT);
    CREATE TABLE local_mapping_observations (merchant_key TEXT);
    CREATE VIEW merchant_assignments AS SELECT merchant FROM merchant_assignment_reviews;
  `);
  const review = store.db.prepare('INSERT INTO merchant_assignment_reviews VALUES (?,?,?,?,?,?)');
  review.run('a', 'coffee variant', 'Coffee Co', 'food', 'approved', null);
  review.run('b', 'another coffee', 'Coffee Co', 'other', 'approved', null);
  review.run('a', 'descriptor only', 'Invented AI Payee', 'food', 'pending', null);
  review.run('a', 'books', 'Books', 'missing', 'approved', null);
  review.run('a', 'old corner', 'Old Corner', 'food', 'approved', null);
  review.run('b', 'old corner', '', '', 'deleted', null);
  store.db.prepare('INSERT INTO merchant_mappings VALUES (?)').run('history only');
  store.db.prepare('INSERT INTO actual_mapping_observations VALUES (?)').run('older history');
  store.db.prepare('INSERT INTO local_mapping_observations VALUES (?)').run('local history');
}
it('migrates explicit defaults and conflicts, discovers payees, and removes approval and learning state atomically', () => {
  const store = open();
  legacy(store);
  const { id } = store.enqueue({ ...payload, eventId: 'previous' });
  store.update(id, 'imported', {
    parsed: { kind: 'purchase', payee: 'My SMS Descriptor' } as never,
  });
  store.db
    .prepare('INSERT INTO event_import_ids VALUES (?,?,?,?)')
    .run(id, 'main', 'old-id', 'new-id');
  store.recordEnrichment(id, 'merchant_assignment_pending', { previous: true });
  const events = store.db.prepare('SELECT * FROM events').all();
  const audit = store.db.prepare('SELECT * FROM enrichment_attempts').all();
  expect(store.payees.migrationPending).toBe(true);
  store.db.exec(
    "CREATE TRIGGER fail_migration BEFORE INSERT ON service_migrations BEGIN SELECT RAISE(ABORT, 'forced failure'); END;",
  );
  expect(() => store.payees.refresh(catalog)).toThrow('forced failure');
  expect(store.payees.migrationPending).toBe(true);
  expect(store.payees.list('', 0, 50)).toEqual([]);
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM merchant_assignments').get()).toEqual({
    n: 6,
  });
  store.db.exec('DROP TRIGGER fail_migration');

  store.payees.refresh(catalog, [
    {
      id: 'actual-tx',
      payeeId: 'books',
      accountId: 'a',
      date: '2026-08-22',
      importedPayee: 'My SMS Descriptor',
      importedId: 'new-id',
    },
  ]);
  expect(store.payees.migrationPending).toBe(false);
  expect(store.payees.list('coffee co', 0, 1)[0]).toMatchObject({
    actualId: 'coffee',
    categoryId: null,
    aliases: [{ key: 'another coffee' }, { key: 'coffee variant' }],
    conflict: [{ categoryId: 'food' }, { categoryId: 'other' }],
  });
  const book = store.payees.list('my sms descriptor', 0, 1)[0]!;
  expect(book).toMatchObject({ actualId: 'books', categoryId: 'missing', tagIds: [] });
  expect(store.payees.defaults('Books')?.categoryId).toBeUndefined();
  expect(store.payees.list('old corner', 0, 1)[0]).toMatchObject({
    categoryId: null,
    conflict: [{ categoryId: 'food' }, { categoryId: null }],
  });
  for (const search of ['descriptor only', 'history only', 'older history', 'local history'])
    expect(store.payees.list(search, 0, 1)[0]).toMatchObject({ categoryId: null });
  expect(store.payees.list('invented ai payee', 0, 50)).toEqual([]);
  expect(store.payees.list('transfer', 0, 50)).toEqual([]);
  const before = store.payees.list('', 0, 50);
  store.payees.refresh(catalog);
  expect(store.payees.list('', 0, 50)).toEqual(before);
  expect(
    store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name LIKE '%mapping%' OR name LIKE 'merchant_assignment%'",
      )
      .all(),
  ).toEqual([]);
  expect(store.db.prepare('SELECT * FROM events').all()).toEqual(events);
  expect(store.db.prepare('SELECT * FROM enrichment_attempts').all()).toEqual(audit);
  expect(store.db.prepare('SELECT imported_id FROM event_import_ids').get()).toEqual({
    imported_id: 'new-id',
  });
});

it('preserves ambiguous descriptors, supports reversible links, and skips unavailable metadata', () => {
  const store = open();
  store.payees.refresh({
    ...catalog,
    payees: [...catalog.payees, { id: 'collision', name: 'COFFEE-CO' }],
  });
  expect(store.payees.defaults('coffee co')?.payeeId).toBeUndefined();
  const rows = store.payees.list('coffee co', 0, 50);
  expect(rows).toHaveLength(3);
  const origin = rows.find(row => !row.actualId)!;
  const target = rows.find(row => row.actualId === 'coffee')!;
  store.payees.save(origin.id, origin.revision, 'food', ['work']);
  store.payees.save(target.id, target.revision, 'other', []);
  expect(() =>
    store.payees.link(
      'coffee co',
      origin.id,
      store.payees.get(origin.id)!.revision,
      target.id,
      store.payees.get(target.id)!.revision,
    ),
  ).toThrow(PayeeConflict);
  store.payees.save(target.id, store.payees.get(target.id)!.revision, null, []);
  store.payees.link(
    'coffee co',
    origin.id,
    store.payees.get(origin.id)!.revision,
    target.id,
    store.payees.get(target.id)!.revision,
  );
  expect(store.payees.defaults('COFFEE-CO')).toMatchObject({
    payeeId: 'coffee',
    categoryId: 'food',
    tags: ['Work'],
  });
  store.payees.refresh({
    ...catalog,
    payees: [{ id: 'coffee', name: 'Cafe Renamed' }],
    categories: [],
    tags: [],
  });
  expect(store.payees.get(target.id)).toMatchObject({
    name: 'Cafe Renamed',
    categoryId: 'food',
    tagIds: ['work'],
  });
  expect(store.payees.defaults('coffee co')).toMatchObject({
    payeeId: 'coffee',
    categoryId: undefined,
    tags: [],
  });
  store.payees.unlink('coffee co', target.id, store.payees.get(target.id)!.revision);
  store.payees.refresh(catalog);
  expect(store.payees.defaults('coffee co')).toMatchObject({
    payeeId: undefined,
    categoryId: undefined,
    tags: [],
  });
});

it('freezes payee and notes across retries and never scans transaction history after migration', async () => {
  const f = await runtimeFixture();
  const store = open();
  try {
    f.actual.categories = async () => [...catalog.categories, { id: 'fees', name: 'Fees' }];
    f.actual.payees = async () => catalog.payees;
    f.actual.tags = async () => catalog.tags;
    const history = vi.fn(async () => []);
    f.actual.transactions = history;
    const adapter = vi
      .fn<typeof f.actual.importTransactions>()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValue({ added: ['actual-1'], updated: [], errors: [] });
    f.actual.importTransactions = adapter;
    const processor = new Processor(store, f.actual, f.config, 5, f.runtime.gate);
    f.config.accounts.push({
      key: 'credit-card',
      id: 'credit-card',
      name: 'Credit Card',
      match: { bank: 'sab', accountSuffixes: ['5678'] },
    });
    await processor.refreshPayees();
    const row = store.payees.list('coffee co', 0, 1)[0]!;
    store.payees.save(row.id, row.revision, 'food', ['work']);
    const { id } = store.enqueue({ ...payload, eventId: 'current' });
    await processor.tick();
    const first = adapter.mock.calls[0]?.[1][0];
    expect(first).toMatchObject({
      payee: 'coffee',
      category: 'food',
      notes: expect.stringContaining('#Work'),
    });
    expect(first).not.toHaveProperty('preservePendingAssignment');
    store.payees.save(row.id, store.payees.get(row.id)!.revision, 'other', []);
    await processor.refreshPayees();
    expect(history).not.toHaveBeenCalled();
    store.update(id, 'queued', { nextAttemptAt: new Date(0).toISOString() });
    await processor.tick();
    expect(adapter.mock.calls[1]?.[1][0]).toEqual(first);
    expect(store.get(id)?.status).toBe('imported');
    store.enqueue({
      ...payload,
      eventId: 'other-account',
      message: payload.message.replace('1234', '5678'),
    });
    await processor.tick();
    expect(adapter.mock.calls[2]?.[0]).toBe('credit-card');
    expect(adapter.mock.calls[2]?.[1][0]).toMatchObject({ payee: 'coffee', category: 'other' });
    expect(store.payees.list('coffee co', 0, 50)).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

it('leaves the queue untouched until a legacy upgrade can sync and retries it on the next refresh', async () => {
  const f = await runtimeFixture();
  const store = open();
  try {
    legacy(store);
    const { id } = store.enqueue({ ...payload, eventId: 'waiting-for-catalog' });
    f.actual.sync = vi
      .fn()
      .mockRejectedValueOnce(new Error('test outage'))
      .mockResolvedValue(undefined);
    const history = vi.fn(async () => []);
    f.actual.transactions = history;
    const processor = new Processor(store, f.actual, f.config, 5, f.runtime.gate);
    await expect(processor.refreshPayees()).rejects.toThrow('test outage');
    await processor.tick();
    expect(store.get(id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(history).not.toHaveBeenCalled();
    await processor.refreshPayees();
    expect(history).toHaveBeenCalledOnce();
    expect(store.payees.migrationPending).toBe(false);
    await processor.refreshPayees();
    expect(history).toHaveBeenCalledOnce();
    await processor.tick();
    expect(store.get(id)?.status).toBe('imported');
  } finally {
    await f.cleanup();
  }
});

it.each(['other', 'food'])(
  'shows competing payee names on the original descriptor even when categories are %s',
  secondCategory => {
    const store = open();
    legacy(store);
    const review = store.db.prepare('INSERT INTO merchant_assignment_reviews VALUES (?,?,?,?,?,?)');
    review.run('checking', 'cafe terminal', 'Coffee Co', 'food', 'approved', null);
    review.run('credit', 'cafe terminal', 'Books', secondCategory, 'approved', null);
    store.payees.refresh(catalog);
    const [descriptor] = store.payees.list('cafe terminal', 0, 10);
    expect(descriptor).toMatchObject({
      actualId: null,
      categoryId: null,
      conflict: [
        { accountId: 'checking', payee: 'Coffee Co', categoryId: 'food' },
        { accountId: 'credit', payee: 'Books', categoryId: secondCategory },
      ],
    });
    store.payees.save(descriptor!.id, descriptor!.revision, null, ['work']);
    const tagged = store.payees.get(descriptor!.id)!;
    expect(tagged).toMatchObject({ tagIds: ['work'], conflict: descriptor!.conflict });
    store.payees.save(tagged.id, tagged.revision, null, ['work'], true);
    expect(store.payees.get(tagged.id)).toMatchObject({
      categoryId: null,
      conflict: [],
      tagIds: ['work'],
    });
  },
);

it('requires compatible saved settings before moving a descriptor between Actual payees', () => {
  const store = open();
  store.payees.refresh(catalog);
  store.payees.defaults('Coffee Co');
  const source = store.payees.list('coffee co', 0, 1)[0]!;
  const target = store.payees.list('books', 0, 1)[0]!;
  store.payees.save(source.id, source.revision, 'food', ['work']);
  store.payees.save(target.id, target.revision, 'other', []);
  const link = () =>
    store.payees.link(
      'coffee co',
      source.id,
      store.payees.get(source.id)!.revision,
      target.id,
      store.payees.get(target.id)!.revision,
    );
  expect(link).toThrow(PayeeConflict);
  expect(store.payees.defaults('Coffee Co')?.categoryId).toBe('food');
  store.payees.save(target.id, store.payees.get(target.id)!.revision, 'food', ['work']);
  link();
  expect(store.payees.defaults('Coffee Co')).toMatchObject({
    payeeId: 'books',
    categoryId: 'food',
    tags: ['Work'],
  });
  expect(store.payees.get(source.id)).toMatchObject({
    actualId: 'coffee',
    categoryId: 'food',
    tagIds: ['work'],
  });
});

it('uses a verified new Actual transaction for alias discovery and isolates later conflicting outcomes', async () => {
  const f = await runtimeFixture();
  const store = open();
  try {
    f.actual.payees = async () => catalog.payees;
    f.actual.categories = async () => catalog.categories;
    f.actual.tags = async () => catalog.tags;
    const lookup = vi
      .fn<ActualFixture['importedTransactionPayee']>()
      .mockResolvedValueOnce('coffee')
      .mockResolvedValueOnce('books');
    f.actual.importedTransactionPayee = lookup;
    const writes = vi
      .fn<ActualFixture['importTransactions']>()
      .mockResolvedValueOnce({ added: [], updated: ['matched'], errors: [] })
      .mockResolvedValueOnce({ added: ['new-actual-id'], updated: [], errors: [] })
      .mockResolvedValueOnce({ added: ['new-conflicting-id'], updated: [], errors: [] })
      .mockResolvedValueOnce({ added: ['new-manual-id'], updated: [], errors: [] });
    f.actual.importTransactions = writes;
    const processor = new Processor(store, f.actual, f.config, 5, f.runtime.gate);
    await processor.refreshPayees();
    const canonical = store.payees.list('coffee co', 0, 1)[0]!;
    store.payees.save(canonical.id, canonical.revision, 'food', ['work']);
    const submit = (eventId: string, total: number) =>
      store.enqueue({
        ...payload,
        eventId,
        message: `Purchase Card:1234 Amount: SAR ${total} at TERMINAL CAFE`,
      });
    submit('fuzzy', 11);
    await processor.tick();
    expect(lookup).not.toHaveBeenCalled();
    submit('new', 12);
    await processor.tick();
    expect(lookup).toHaveBeenCalledWith(
      'checking',
      'new-actual-id',
      writes.mock.calls[1]?.[1][0]?.imported_id,
    );
    expect(store.payees.list('terminal cafe', 0, 10)).toMatchObject([{ id: canonical.id }]);
    submit('conflict', 13);
    await processor.tick();
    expect(writes.mock.calls[2]?.[1][0]).toMatchObject({
      payee: 'coffee',
      category: 'food',
      notes: expect.stringContaining('#Work'),
    });
    const standalone = store.payees.list('terminal cafe', 0, 10)[0]!;
    expect(standalone).toMatchObject({ actualId: null, categoryId: null, tagIds: [] });
    expect(store.payees.get(canonical.id)).toMatchObject({ categoryId: 'food', tagIds: ['work'] });
    const target = store.payees.get(canonical.id)!;
    store.payees.link(
      'terminal cafe',
      standalone.id,
      standalone.revision,
      target.id,
      target.revision,
    );
    submit('manual', 14);
    await processor.tick();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(store.payees.list('terminal cafe', 0, 10)).toMatchObject([{ id: canonical.id }]);
  } finally {
    await f.cleanup();
  }
});

type ActualFixture = Awaited<ReturnType<typeof runtimeFixture>>['actual'];
