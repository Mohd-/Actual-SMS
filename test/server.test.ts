import { banks } from './fixtures/banks.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EventStore } from '../src/db.js';
import { buildServer } from '../src/server.js';
import type { Processor } from '../src/processor.js';

const stores: EventStore[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores) store.close();
  stores.length = 0;
});

function buildApp(store: EventStore) {
  return buildServer({
    apiKey: 'secret',
    banks,
    store,
    processor: { tick: async () => {} } as Processor,
    ready: () => true,
  });
}

describe('batch API', () => {
  it('enqueues every event in order and dedupes resubmissions by eventId', async () => {
    const store = new EventStore(':memory:');
    stores.push(store);
    const app = buildApp(store);
    const batch = {
      events: [
        {
          eventId: 'inbox-1',
          sender: 'SAB',
          message: 'one',
          receivedAt: '2026-08-22T10:00:00+03:00',
        },
        {
          eventId: 'inbox-2',
          sender: 'SAB',
          message: 'two',
          receivedAt: '2026-08-22T10:01:00+03:00',
        },
      ],
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/sms/batch',
      headers: { 'x-api-key': 'secret' },
      payload: batch,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().results).toMatchObject([
      { eventId: 'inbox-1', duplicate: false, statusUrl: '/v1/events/inbox-1' },
      { eventId: 'inbox-2', duplicate: false, statusUrl: '/v1/events/inbox-2' },
    ]);

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/sms/batch',
      headers: { 'x-api-key': 'secret' },
      payload: {
        events: [
          batch.events[0],
          {
            eventId: 'inbox-3',
            sender: 'SAB',
            message: 'three',
            receivedAt: '2026-08-22T10:02:00+03:00',
          },
        ],
      },
    });
    await app.close();
    expect(replay.statusCode).toBe(202);
    expect(replay.json().results).toMatchObject([
      { eventId: 'inbox-1', duplicate: true },
      { eventId: 'inbox-3', duplicate: false },
    ]);
    expect(store.list({ limit: 200 }).map(event => event.id)).toEqual([
      'inbox-3',
      'inbox-2',
      'inbox-1',
    ]);
  });
  it('rejects any invalid item without enqueueing anything', async () => {
    const store = new EventStore(':memory:');
    stores.push(store);
    const app = buildApp(store);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/sms/batch',
      headers: { 'x-api-key': 'secret' },
      payload: {
        events: [
          { eventId: 'inbox-1', message: 'ok', receivedAt: '2026-08-22T10:00:00+03:00' },
          { eventId: 'inbox-2', message: 'bad', receivedAt: 'not-a-timestamp' },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
    expect(response.json().details[0].path).toBe('events.1.receivedAt');
    expect(store.get('inbox-1')).toBeUndefined();

    const unknownField = await app.inject({
      method: 'POST',
      url: '/v1/sms/batch',
      headers: { 'x-api-key': 'secret' },
      payload: {
        events: [
          { eventId: 'inbox-1', message: 'ok', receivedAt: '2026-08-22T10:00:00+03:00', extra: 1 },
        ],
      },
    });
    await app.close();
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.json().details[0]).toMatchObject({
      path: 'events.0',
      message: expect.stringContaining('extra'),
    });
    expect(store.get('inbox-1')).toBeUndefined();
  });
  it('rejects batches above the event cap and unauthenticated requests', async () => {
    const store = new EventStore(':memory:');
    stores.push(store);
    const app = buildApp(store);
    const event = { eventId: 'inbox-1', message: 'x', receivedAt: '2026-08-22T10:00:00+03:00' };

    const oversized = await app.inject({
      method: 'POST',
      url: '/v1/sms/batch',
      headers: { 'x-api-key': 'secret' },
      payload: { events: Array.from({ length: 101 }, () => event) },
    });
    expect(oversized.statusCode).toBe(400);

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/v1/sms/batch',
      payload: { events: [event] },
    });
    await app.close();
    expect(unauthorized.statusCode).toBe(401);
    expect(store.get('inbox-1')).toBeUndefined();
  });
});

describe('inbox sync API', () => {
  it('initializes seven days back and advances through accepted and discarded rows', async () => {
    const store = new EventStore(':memory:');
    stores.push(store);
    const app = buildApp(store);
    const expectedStart = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const start = await app.inject({
      method: 'POST',
      url: '/v1/inbox-sync/start',
      headers: { 'x-api-key': 'secret' },
    });
    const checkpoint = start.json().checkpoint;
    expect(checkpoint.rowId).toBe(0);
    expect(checkpoint.date).toBeGreaterThanOrEqual(expectedStart);
    expect(checkpoint.date).toBeLessThanOrEqual(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const rows = [
      {
        rowId: 10,
        date: checkpoint.date + 1,
        sender: 'AlRajhiBank',
        message: 'bank payload',
      },
      {
        rowId: 11,
        date: checkpoint.date + 2,
        sender: 'Personal Contact',
        message: 'private unsupported payload',
      },
      { rowId: 12, date: checkpoint.date + 3, sender: null, message: null },
      { rowId: 13, date: checkpoint.date + 4, sender: 'STC Bank', message: 'review payload' },
      { rowId: 14, date: checkpoint.date + 5, sender: 'D360 Bank', message: 'D360 payload' },
    ];
    const response = await app.inject({
      method: 'POST',
      url: '/v1/inbox-sync/batch',
      headers: { 'x-api-key': 'secret' },
      payload: { checkpoint, rows },
    });
    await app.close();

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      checkpoint: { date: rows[4]!.date, rowId: 14 },
      results: [
        { rowId: 10, outcome: 'queued', eventId: `inbox-v2-${rows[0]!.date}-10` },
        { rowId: 11, outcome: 'unsupported' },
        { rowId: 12, outcome: 'empty' },
        { rowId: 13, outcome: 'queued', eventId: `inbox-v2-${rows[3]!.date}-13` },
        { rowId: 14, outcome: 'queued', eventId: `inbox-v2-${rows[4]!.date}-14` },
      ],
    });
    expect(store.list({ limit: 20 })).toHaveLength(3);
    expect(JSON.stringify(store.db.prepare('SELECT payload FROM events').all())).not.toContain(
      'private unsupported payload',
    );
  });

  it('normalizes raw Tasker inbox identifier fields on the server', async () => {
    const store = new EventStore(':memory:');
    stores.push(store);
    const app = buildApp(store);
    const checkpoint = store.startInboxSync(1_000_000_000);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/inbox-sync/batch',
      headers: { 'x-api-key': 'secret' },
      payload: {
        checkpoint,
        rows: [{ rowId: ' 42 ', date: String(checkpoint.date + 1), sender: null, message: null }],
      },
    });
    await app.close();
    expect(response.statusCode).toBe(202);
    expect(response.json().checkpoint).toEqual({ date: checkpoint.date + 1, rowId: 42 });
  });

  it('recovers unsplit comma-separated Tasker rows without losing SMS commas or newlines', async () => {
    const store = new EventStore(':memory:');
    stores.push(store);
    const app = buildApp(store);
    const checkpoint = store.startInboxSync(1_000_000_000);
    const date = checkpoint.date + 1;
    const message =
      'International POS Purchase\nAmount: JPY 1,878.00 (SAR 44.70)\nAt: EXAMPLE, STORE';
    const raw = `42,D360 Bank,${message},${date}`;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/inbox-sync/batch',
      headers: { 'x-api-key': 'secret' },
      payload: { checkpoint, rows: [{ rowId: raw, date: raw, sender: null, message: null }] },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      checkpoint: { date, rowId: 42 },
      results: [{ rowId: 42, outcome: 'queued' }],
    });
    expect(JSON.parse(store.get(`inbox-v2-${date}-42`)!.payload!)).toMatchObject({
      sender: 'D360 Bank',
      message,
      receivedAt: new Date(date).toISOString(),
    });
    await app.close();
  });

  it('rejects malformed Tasker rows without advancing the checkpoint or enqueueing partial SMS', async () => {
    const store = new EventStore(':memory:');
    stores.push(store);
    const app = buildApp(store);
    const checkpoint = store.startInboxSync(1_000_000_000);
    for (const raw of ['42,D360 Bank,message,invalid-date', '42,D360 Bank,no-date']) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/inbox-sync/batch',
        headers: { 'x-api-key': 'secret' },
        payload: { checkpoint, rows: [{ rowId: raw, date: raw, sender: null, message: null }] },
      });
      expect(response.statusCode).toBe(400);
      expect(store.inboxCheckpoint()).toEqual(checkpoint);
      expect(store.list({ limit: 20 })).toHaveLength(0);
    }
    await app.close();
  });

  it('deduplicates legacy inbox IDs and rejects stale or unordered batches', async () => {
    const store = new EventStore(':memory:');
    stores.push(store);
    const app = buildApp(store);
    const checkpoint = store.startInboxSync(1_000_000_000);
    const date = checkpoint.date + 1;
    store.enqueue({
      eventId: `inbox-v2-${date}-1`,
      sender: 'SAB',
      message: 'existing',
      receivedAt: new Date(date).toISOString(),
    });

    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/inbox-sync/batch',
      headers: { 'x-api-key': 'secret' },
      payload: {
        checkpoint,
        rows: [{ rowId: 1, date, sender: 'SAB', message: 'existing' }],
      },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().results[0]).toMatchObject({ outcome: 'duplicate' });

    const stale = await app.inject({
      method: 'POST',
      url: '/v1/inbox-sync/batch',
      headers: { 'x-api-key': 'secret' },
      payload: {
        checkpoint,
        rows: [{ rowId: 2, date: date + 1, sender: 'SAB', message: 'new' }],
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: 'checkpoint_conflict',
      checkpoint: { date, rowId: 1 },
    });
    expect(store.get(`inbox-v2-${date + 1}-2`)).toBeUndefined();

    const unordered = await app.inject({
      method: 'POST',
      url: '/v1/inbox-sync/batch',
      headers: { 'x-api-key': 'secret' },
      payload: {
        checkpoint: { date, rowId: 1 },
        rows: [
          { rowId: 3, date: date + 2, sender: 'SAB', message: 'later' },
          { rowId: 2, date: date + 1, sender: 'SAB', message: 'earlier' },
        ],
      },
    });
    await app.close();
    expect(unordered.statusCode).toBe(400);
    expect(unordered.json()).toMatchObject({ error: 'invalid_row_order', index: 1 });
  });

  it('rewinds only backward, is idempotent, and requires authentication', async () => {
    const store = new EventStore(':memory:');
    stores.push(store);
    const app = buildApp(store);
    const checkpoint = store.startInboxSync(2_000_000_000);

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/inbox-sync/start',
        })
      ).statusCode,
    ).toBe(401);
    const rewind = await app.inject({
      method: 'POST',
      url: '/v1/inbox-sync/rewind',
      headers: { 'x-api-key': 'secret' },
      payload: { date: checkpoint.date - 1000 },
    });
    expect(rewind.statusCode).toBe(200);
    expect(rewind.json()).toEqual({
      checkpoint: { date: checkpoint.date - 1000, rowId: 0 },
      changed: true,
    });

    const forward = await app.inject({
      method: 'POST',
      url: '/v1/inbox-sync/rewind',
      headers: { 'x-api-key': 'secret' },
      payload: { date: checkpoint.date },
    });
    await app.close();
    expect(forward.statusCode).toBe(200);
    expect(forward.json()).toEqual({
      checkpoint: { date: checkpoint.date - 1000, rowId: 0 },
      changed: false,
    });
    expect(store.inboxCheckpoint()).toEqual({ date: checkpoint.date - 1000, rowId: 0 });
  });
});

describe('Tasker inbox project', () => {
  const readProject = (name: string) =>
    readFileSync(new URL(`../tasker/${name}`, import.meta.url), 'utf8');

  it('uses server checkpoints without sender filters or persistent cursor globals', () => {
    const project = readProject('Actual_SMS_Inbox.prj.xml');
    expect(project).toContain('%ActualSmsServiceUrl/v1/inbox-sync/start');
    expect(project).toContain('%ActualSmsServiceUrl/v1/inbox-sync/batch');
    expect(project).toContain('%ActualSmsServiceUrl/v1/inbox-sync/rewind');
    expect(project).not.toContain('address IN');
    expect(project).not.toContain('ActualSmsInboxV2');
    expect(project).not.toContain('invalid row identifier');
  });

  it('configures the service URL at import time without fixed deployment hosts', () => {
    const project = readProject('Actual_SMS_Inbox.prj.xml');
    expect(project).toContain('<pvn>%ActualSmsServiceUrl</pvn>');
    expect(project).not.toMatch(/https:\/\/[^<]+\/v1\//u);
  });
});

describe('event API', () => {
  it('exposes parser reasons separately from operational errors', async () => {
    const store = new EventStore(':memory:');
    stores.push(store);
    const id = store.enqueue({
      eventId: 'review',
      message: 'x',
      receivedAt: new Date().toISOString(),
    }).id;
    store.update(id, 'needs_review', { parserReason: 'unrecognized_template' });
    const app = buildServer({
      apiKey: 'secret',
      banks,
      store,
      processor: { tick: async () => {} } as Processor,
      ready: () => true,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/events/${id}`,
      headers: { 'x-api-key': 'secret' },
    });
    await app.close();

    expect(response.json()).toMatchObject({
      eventId: id,
      status: 'needs_review',
      parserReason: 'unrecognized_template',
      error: null,
    });
  });
  it('paginates summaries and exposes permanent audit details only with authentication', async () => {
    const store = new EventStore(':memory:');
    stores.push(store);
    const first = store.enqueue({
      eventId: 'first',
      message: 'first private message',
      receivedAt: '2026-08-22T10:10:30+03:00',
    }).id;
    store.recordEnrichment(first, 'history_miss', { merchant: 'Shop' });
    store.enqueue({
      eventId: 'second',
      message: 'second private message',
      receivedAt: '2026-08-22T10:11:30+03:00',
    });
    const app = buildServer({
      apiKey: 'secret',
      banks,
      store,
      processor: { tick: async () => {} } as Processor,
      ready: () => true,
    });

    expect((await app.inject({ method: 'GET', url: '/v1/events' })).statusCode).toBe(401);
    const page = await app.inject({
      method: 'GET',
      url: '/v1/events?limit=1',
      headers: { 'x-api-key': 'secret' },
    });
    expect(page.json().events).toHaveLength(1);
    expect(JSON.stringify(page.json())).not.toContain('private message');
    expect(page.json().nextCursor).toBeTypeOf('string');

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/events/${first}`,
      headers: { 'x-api-key': 'secret' },
    });
    await app.close();
    expect(detail.json()).toMatchObject({
      input: { message: 'first private message' },
      enrichmentStatus: 'history_miss',
    });
    expect(detail.json().history.length).toBeGreaterThan(0);
    expect(detail.json().enrichmentAttempts).toHaveLength(1);
  });
});
