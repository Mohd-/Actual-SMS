import Fastify from 'fastify';
import { z } from 'zod';
import { InboxCheckpointConflict, type EventStore } from './db.js';
import type { BankConfig } from './types.js';
import type { Processor } from './processor.js';
import { resolveSmsSource } from './sms-source.js';
import { eventQuerySchema, listEvents, eventDetail } from './event-queries.js';
import { registerManagement, type ManagementOptions } from './management/routes.js';
import type { ManagementCredentials } from './management/credentials.js';

const smsInputSchema = z.object({
  eventId: z.string().min(1).max(200).optional(),
  sender: z.string().max(100).optional(),
  message: z.string().min(1).max(20_000),
  receivedAt: z.string().datetime({ offset: true }),
  location: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracyMeters: z.number().nonnegative().optional(),
    })
    .optional(),
});
const bodySchema = smsInputSchema.strict();
const batchSchema = z.object({ events: smsInputSchema.strict().array().min(1).max(100) }).strict();
const checkpointSchema = z
  .object({ date: z.number().int().min(0), rowId: z.number().int().min(0) })
  .strict();
const inboxIntegerSchema = z
  .union([z.number(), z.string().trim().regex(/^\d+$/)])
  .transform(value => (typeof value === 'number' ? value : Number(value)))
  .pipe(z.number().int());
// Older Tasker imports lose the tab divider and return comma-separated rows.
// Their JavaScript then sends the same unsplit row as both numeric fields.
// Recover only that exact shape; the first two and final commas bound the
// columns, preserving commas and newlines inside the SMS body.
function normalizeTaskerRow(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const row = value as Record<string, unknown>;
  if (
    typeof row.rowId !== 'string' ||
    row.rowId !== row.date ||
    row.sender !== null ||
    row.message !== null
  )
    return value;
  const raw = row.rowId;
  const first = raw.indexOf(',');
  const second = raw.indexOf(',', first + 1);
  const last = raw.lastIndexOf(',');
  if (first < 0 || second < 0 || last <= second) return value;
  return {
    ...row,
    rowId: raw.slice(0, first),
    sender: raw.slice(first + 1, second).trim() || null,
    message: raw.slice(second + 1, last),
    date: raw.slice(last + 1),
  };
}
const inboxRowSchema = z.preprocess(
  normalizeTaskerRow,
  z
    .object({
      // Tasker sends the content-provider fields verbatim. The server owns their
      // normalization because it also owns the checkpoint they advance.
      rowId: inboxIntegerSchema.pipe(z.number().min(0)),
      date: inboxIntegerSchema.pipe(z.number().positive().max(8_640_000_000_000_000)),
      sender: z.string().max(100).nullable(),
      message: z.string().max(20_000).nullable(),
    })
    .strict(),
);
const inboxBatchSchema = z
  .object({ checkpoint: checkpointSchema, rows: inboxRowSchema.array().min(1).max(25) })
  .strict();
const rewindSchema = z.object({ date: z.number().int().min(0) }).strict();
export function buildServer(options: {
  apiKey: string;
  banks: BankConfig[] | (() => BankConfig[]);
  store: EventStore;
  processor: Processor;
  ready: () => boolean;
  logger?: boolean | string;
  management?: ManagementOptions;
  taskerCredentials?: Pick<ManagementCredentials, 'isTaskerKey'>;
}) {
  const app = Fastify({
    logger: options.logger
      ? {
          level: typeof options.logger === 'string' ? options.logger : 'info',
          redact: [
            'req.headers.x-api-key',
            'req.headers.cookie',
            'res.headers.set-cookie',
            'req.headers.authorization',
            'req.body.password',
            'req.body.key',
            'req.body.accounts',
            'req.body.message',
            'req.body.events[*].message',
            'req.body.rows[*].message',
          ],
        }
      : false,
    bodyLimit: 24 * 1024,
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) =>
    options.ready() ? { status: 'ready' } : reply.code(503).send({ status: 'not_ready' }),
  );
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz' || req.url === '/readyz') return;
    if (
      options.management &&
      (req.url === '/manage' ||
        req.url.startsWith('/manage/') ||
        req.url.startsWith('/management/'))
    )
      return;
    const supplied = req.headers['x-api-key'];
    if ((options.taskerCredentials ?? options.management?.credentials)?.isTaskerKey(supplied)) {
      const path = req.url.split('?')[0];
      if (
        req.method === 'POST' &&
        [
          '/v1/sms',
          '/v1/sms/batch',
          '/v1/inbox-sync/start',
          '/v1/inbox-sync/batch',
          '/v1/inbox-sync/rewind',
        ].includes(path!)
      )
        return;
      return reply.code(403).send({ error: 'Restricted Tasker credential' });
    }
    let valid = false;
    if (typeof supplied === 'string' && supplied.length === options.apiKey.length) {
      let v = 0;
      for (let i = 0; i < supplied.length; i++)
        v |= supplied.charCodeAt(i) ^ options.apiKey.charCodeAt(i);
      valid = v === 0;
    }
    if (!valid) return reply.code(401).send({ error: 'unauthorized' });
  });
  app.post('/v1/sms', async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: 'invalid_request',
        details: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      });
    const result = options.store.enqueue(parsed.data);
    void options.processor.tick();
    return reply.code(202).send({
      eventId: result.id,
      duplicate: result.duplicate,
      statusUrl: `/v1/events/${encodeURIComponent(result.id)}`,
    });
  });
  app.post<{ Body: unknown }>(
    '/v1/sms/batch',
    { bodyLimit: 5 * 1024 * 1024 },
    async (req, reply) => {
      const parsed = batchSchema.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: 'invalid_request',
          details: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
        });
      const results = parsed.data.events.map(event => {
        const result = options.store.enqueue(event);
        return {
          eventId: result.id,
          duplicate: result.duplicate,
          statusUrl: `/v1/events/${encodeURIComponent(result.id)}`,
        };
      });
      void options.processor.tick();
      return reply.code(202).send({ results });
    },
  );
  app.post('/v1/inbox-sync/start', async () => ({ checkpoint: options.store.startInboxSync() }));
  app.post<{ Body: unknown }>(
    '/v1/inbox-sync/batch',
    { bodyLimit: 5 * 1024 * 1024 },
    async (req, reply) => {
      const parsed = inboxBatchSchema.safeParse(req.body);
      if (!parsed.success) {
        const details = parsed.error.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message,
        }));
        const rows = (req.body as { rows?: unknown[] })?.rows;
        const first = rows?.[0] as { rowId?: unknown; date?: unknown } | undefined;
        const rowId = typeof first?.rowId === 'string' ? first.rowId : '';
        req.log.warn(
          {
            details,
            firstRowFormat: {
              rowIdType: typeof first?.rowId,
              dateType: typeof first?.date,
              identicalFields: first?.rowId === first?.date,
              rowIdLength: rowId.length,
              tabs: rowId.split('\t').length - 1,
              literalTabs: rowId.split('\\t').length - 1,
              pipes: rowId.split('|').length - 1,
              commas: rowId.split(',').length - 1,
              newlines: rowId.split('\n').length - 1,
            },
          },
          'Inbox sync batch validation failed',
        );
        return reply.code(400).send({ error: 'invalid_request', details });
      }
      let previous = parsed.data.checkpoint;
      for (const [index, row] of parsed.data.rows.entries()) {
        if (
          row.date < previous.date ||
          (row.date === previous.date && row.rowId <= previous.rowId)
        ) {
          req.log.warn(
            { index, previous, row: { date: row.date, rowId: row.rowId } },
            'Inbox sync batch row order invalid',
          );
          return reply.code(400).send({ error: 'invalid_row_order', index });
        }
        previous = { date: row.date, rowId: row.rowId };
      }
      const entries = parsed.data.rows.map(row => {
        const message = row.message?.trim();
        if (!message) return { row, skipped: 'empty' as const };
        const source = resolveSmsSource(
          row.sender ?? '',
          message,
          typeof options.banks === 'function' ? options.banks() : options.banks,
        );
        if (source.type === 'unsupported' && source.disposition === 'ignored')
          return { row, skipped: 'unsupported' as const };
        return {
          row,
          input: {
            eventId: `inbox-v2-${row.date}-${row.rowId}`,
            ...(row.sender ? { sender: row.sender } : {}),
            message: row.message!,
            receivedAt: new Date(row.date).toISOString(),
          },
        };
      });
      try {
        const result = options.store.commitInboxBatch(parsed.data.checkpoint, entries);
        if (result.results.some(item => item.outcome === 'queued')) void options.processor.tick();
        return reply.code(202).send(result);
      } catch (error) {
        if (error instanceof InboxCheckpointConflict)
          return reply
            .code(409)
            .send({ error: 'checkpoint_conflict', checkpoint: error.checkpoint });
        throw error;
      }
    },
  );
  app.post<{ Body: unknown }>('/v1/inbox-sync/rewind', async (req, reply) => {
    const parsed = rewindSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: 'invalid_request',
        details: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      });
    const result = options.store.rewindInboxSync(parsed.data.date);
    // Reconciliation is intentionally idempotent. A previous reconciliation may
    // already have moved the cursor farther back than this request's rolling
    // seven-day boundary; reporting that as an error makes a safe replay look
    // like a corrupted checkpoint.
    return { checkpoint: result.checkpoint, changed: result.changed };
  });
  app.get<{ Querystring: Record<string, unknown> }>('/v1/events', async (req, reply) => {
    const query = eventQuerySchema.safeParse(req.query);
    if (!query.success)
      return reply.code(400).send({ error: 'invalid_query', details: query.error.issues });
    try {
      return listEvents(options.store, query.data);
    } catch {
      return reply.code(400).send({ error: 'invalid_cursor' });
    }
  });
  app.get<{ Params: { id: string } }>('/v1/events/:id', async (req, reply) => {
    const event = eventDetail(options.store, req.params.id);
    return event ?? reply.code(404).send({ error: 'not_found' });
  });
  if (options.management)
    app.register(async management =>
      registerManagement(management, options.management!, options.store),
    );
  return app;
}
