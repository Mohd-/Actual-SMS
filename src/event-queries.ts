import { z } from 'zod';
import type { EventStore } from './db.js';

export const eventQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  status: z
    .enum([
      'queued',
      'processing',
      'imported',
      'ignored',
      'needs_review',
      'imported_review',
      'failed',
    ])
    .optional(),
  enrichmentStatus: z.string().min(1).max(100).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});
export function listEvents(store: EventStore, query: z.infer<typeof eventQuerySchema>) {
  const before = query.cursor
    ? z
        .object({ createdAt: z.string(), id: z.string() })
        .parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')))
    : undefined;
  const rows = store.list({ ...query, before, limit: query.limit + 1 });
  const page = rows.slice(0, query.limit),
    last = page.at(-1);
  return {
    events: page.map(event => ({
      eventId: event.id,
      status: event.status,
      attempts: event.attempts,
      parserReason: event.parser_reason,
      error: event.error,
      enrichmentStatus: event.enrichment_status,
      createdAt: event.created_at,
      updatedAt: event.updated_at,
    })),
    nextCursor:
      rows.length > query.limit && last
        ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString(
            'base64url',
          )
        : undefined,
  };
}
export function eventDetail(store: EventStore, id: string) {
  const e = store.get(id);
  if (!e) return undefined;
  return {
    eventId: e.id,
    status: e.status,
    attempts: e.attempts,
    parsed: e.parsed ? (JSON.parse(e.parsed) as unknown) : undefined,
    suggestion: e.suggestion ? (JSON.parse(e.suggestion) as unknown) : undefined,
    parserReason: e.parser_reason,
    error: e.error,
    enrichmentStatus: e.enrichment_status,
    actualTransactionId: e.actual_transaction_id,
    input: e.payload ? (JSON.parse(e.payload) as unknown) : undefined,
    history: store.eventHistory(e.id).map(item => ({
      id: item.id,
      fromStatus: item.from_status,
      toStatus: item.to_status,
      details: JSON.parse(item.details) as unknown,
      createdAt: item.created_at,
    })),
    enrichmentAttempts: store.enrichmentAttempts(e.id).map(item => ({
      id: item.id,
      status: item.status,
      details: JSON.parse(item.details) as unknown,
      createdAt: item.created_at,
    })),
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  };
}
