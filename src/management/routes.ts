import type { FastifyInstance } from 'fastify';
import secureSession from '@fastify/secure-session';
import rateLimit from '@fastify/rate-limit';
import { compare } from 'bcryptjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Runtime } from '../runtime.js';
import { ConfigConflict, type ConfigEditor } from '../config-editor.js';
import { InboxCheckpointConflict, type EventStore } from '../db.js';
import { eventQuerySchema, eventDetail, listEvents } from '../event-queries.js';
import { taskerProject } from '../tasker-export.js';
import { PayeeConflict } from '../payees.js';
import type { PayeeSuggestions } from '../enricher.js';
import { merchantKey } from '../merchant-key.js';
import { ConfigurationError } from '../runtime-config.js';
import type { ManagementCredentials } from './credentials.js';

declare module '@fastify/secure-session' {
  interface SessionData {
    id: string;
  }
}

export interface ManagementOptions {
  runtime: Runtime;
  editor: ConfigEditor;
  credentials: ManagementCredentials;
  origin: string;
  passwordHash: string;
  secret: string;
  refresh?: () => Promise<void>;
  suggestions?: PayeeSuggestions;
}
export async function registerManagement(
  app: FastifyInstance,
  options: ManagementOptions,
  store: EventStore,
) {
  const origin = new URL(options.origin).origin;
  const tag = createHash('sha256').update(options.passwordHash).digest('hex');
  await app.register(secureSession, {
    key: Buffer.from(options.secret, 'hex'),
    cookieName: 'actual_sms_management',
    expiry: 8 * 60 * 60,
    cookie: {
      path: '/management',
      httpOnly: true,
      sameSite: 'strict',
      secure: origin.startsWith('https:'),
      maxAge: 8 * 60 * 60,
    },
  });
  await app.register(rateLimit, { global: false });
  app.addHook('onSend', async (_req, reply) => {
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'no-referrer')
      .header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
  });
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/management/')) return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== origin)
      return reply.code(403).send({ error: 'Invalid request origin' });
    if (req.url === '/management/login') return;
    if (!options.credentials.validSession(req.session.get('id') as string | undefined, tag))
      return reply.code(401).send({ error: 'Please sign in' });
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ConfigConflict || error instanceof InboxCheckpointConflict)
      return reply.code(409).send({
        error: error.message,
        ...(error instanceof InboxCheckpointConflict ? { checkpoint: error.checkpoint } : {}),
      });
    if (error instanceof PayeeConflict) return reply.code(409).send({ error: error.message });
    if (error instanceof ConfigurationError) return reply.code(400).send({ error: error.message });
    // Library throttling/body limits retain their status without reflecting request data.
    const statusCode =
      error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (statusCode === 429 || statusCode === 413)
      return reply.code(statusCode).send({ error: 'Request limit exceeded' });
    return reply.code(400).send({
      error: 'Operation failed. Check inputs, configuration, permissions and connection status.',
    });
  });
  app.get('/manage', async (_req, reply) =>
    reply.type('text/html').send(await readFile('web/index.html', 'utf8')),
  );
  app.get('/manage/app.js', async (_req, reply) =>
    reply
      .type('application/javascript')
      .send(await readFile('dist/src/management/browser.js', 'utf8')),
  );
  app.get('/manage/style.css', async (_req, reply) =>
    reply.type('text/css').send(await readFile('web/style.css', 'utf8')),
  );
  app.post(
    '/management/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = z
        .object({ password: z.string().min(1).max(72) })
        .strict()
        .safeParse(req.body);
      if (
        !body.success ||
        Buffer.byteLength(body.data.password) > 72 ||
        !(await compare(body.data.password, options.passwordHash))
      )
        return reply.code(401).send({ error: 'Invalid password' });
      const previous = req.session.get('id') as string | undefined;
      if (previous) options.credentials.revoke(previous);
      req.session.set('id', options.credentials.session(tag));
      return { ok: true };
    },
  );
  app.post('/management/logout', async req => {
    options.credentials.revoke(req.session.get('id') as string);
    req.session.delete();
    return { ok: true };
  });
  app.post('/management/sessions/revoke', async req => {
    options.credentials.revokeAll();
    req.session.delete();
    return { ok: true };
  });
  app.get('/management/status', async () => {
    const status = options.runtime.status();
    const payeeMigrationPending = store.payees.migrationPending;
    return {
      ...status,
      ready: status.ready && !payeeMigrationPending,
      counts: store.counts(),
      payeeMigrationPending,
    };
  });
  app.get('/management/events', async (req, reply) => {
    const query = eventQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid filters' });
    return listEvents(store, query.data);
  });
  app.get<{ Params: { id: string } }>(
    '/management/events/:id',
    async (req, reply) =>
      eventDetail(store, req.params.id) ?? reply.code(404).send({ error: 'Message not found' }),
  );
  app.post('/management/reconnect', async () => {
    await options.runtime.reconnect();
    await options.refresh?.();
    return options.runtime.status();
  });
  const payees = store.payees;
  const editPayees = () => options.runtime.status().ready && !payees.migrationPending;
  const rowId = z.string().uuid();
  const revision = z.string().uuid();
  const descriptor = z.string().min(1).max(20_000).transform(merchantKey).pipe(z.string().min(1));
  app.get('/management/payees', async req => {
    const { search, offset } = z
      .object({
        search: z.string().max(200).default(''),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
      })
      .parse(req.query);
    const rows = payees.list(merchantKey(search), offset, 51);
    const accounts = options.runtime.config.accounts.map(({ id, name }) => ({ id, name }));
    return {
      rows: rows.slice(0, 50),
      nextOffset: rows.length > 50 ? offset + 50 : null,
      ...payees.catalog,
      accounts: [...new Map(accounts.map(account => [account.id, account])).values()],
      editable: editPayees(),
      migrationPending: payees.migrationPending,
      suggestions: Boolean(options.suggestions),
    };
  });
  const requirePayees = async (_req: unknown, reply: import('fastify').FastifyReply) => {
    if (!editPayees()) return reply.code(503).send({ error: 'Connect to Actual to edit payees.' });
  };
  app.post('/management/payees/save', { preHandler: requirePayees }, async req => {
    const input = z
      .object({
        id: rowId,
        revision,
        categoryId: z.string().min(1).max(200).nullable(),
        tagIds: z.array(z.string().min(1).max(200)).max(100),
        resolveCategoryConflict: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    payees.save(
      input.id,
      input.revision,
      input.categoryId,
      input.tagIds,
      input.resolveCategoryConflict,
    );
    options.credentials.audit('payee.save', 'success');
    return { ok: true };
  });
  app.post('/management/payees/link', { preHandler: requirePayees }, async req => {
    const input = z
      .object({
        key: descriptor.nullable(),
        id: rowId,
        revision,
        targetId: rowId,
        targetRevision: revision,
      })
      .strict()
      .parse(req.body);
    payees.link(input.key, input.id, input.revision, input.targetId, input.targetRevision);
    options.credentials.audit('payee.link', 'success');
    return { ok: true };
  });
  app.post('/management/payees/unlink', { preHandler: requirePayees }, async req => {
    const input = z.object({ key: descriptor, id: rowId, revision }).strict().parse(req.body);
    payees.unlink(input.key, input.id, input.revision);
    options.credentials.audit('payee.unlink', 'success');
    return { ok: true };
  });
  app.post(
    '/management/payees/suggestion',
    {
      preHandler: requirePayees,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { id, revision: expected } = z.object({ id: rowId, revision }).strict().parse(req.body);
      const row = payees.get(id);
      if (!row || row.revision !== expected)
        return reply.code(409).send({ error: 'Payee changed. Refresh the list and try again.' });
      if (row.categoryId || row.unavailable || !options.suggestions) return { suggestion: null };
      const eligibleIds = new Set(
        options.runtime.config.eligibleCategories.map(category => category.id),
      );
      const categories = payees.catalog.categories
        .filter(category => eligibleIds.has(category.id))
        .map(({ id, name }) => ({ id, name }));
      const suggestion = await options.suggestions.suggest(row.name, categories);
      const current = payees.get(id);
      return {
        suggestion:
          current?.revision === expected &&
          payees.catalog.categories.some(category => category.id === suggestion?.categoryId)
            ? suggestion
            : null,
      };
    },
  );
  app.get('/management/config', async () => options.editor.read());
  const edit = z
    .object({
      accounts: z.string().min(1).max(200000),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict();
  app.post('/management/config/preview', { bodyLimit: 256 * 1024 }, async req => {
    const body = edit.parse(req.body);
    return options.editor.preview(body.accounts, body.revision);
  });
  app.post('/management/config/save', { bodyLimit: 256 * 1024 }, async req => {
    const body = edit.extend({ confirmation: z.literal('SAVE') }).parse(req.body);
    try {
      const result = await options.editor.save(body.accounts, body.revision);
      options.credentials.audit('config.save', 'success', result.revision);
      await options.refresh?.();
      return result;
    } catch (error) {
      options.credentials.audit('config.save', 'failed', body.revision);
      throw error;
    }
  });
  app.post('/management/config/reload', async req => {
    const body = z
      .object({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(req.body);
    try {
      const result = await options.editor.reload(body.revision);
      options.credentials.audit('config.reload', 'success', result.revision);
      await options.refresh?.();
      return result;
    } catch (error) {
      options.credentials.audit('config.reload', 'failed', body.revision);
      throw error;
    }
  });
  app.get('/management/tasker/checkpoint', async () => ({
    checkpoint: store.inboxCheckpoint() ?? null,
  }));
  app.post('/management/tasker/checkpoint', async req => {
    const point = z
      .object({
        date: z.number().int().safe().nonnegative(),
        rowId: z.number().int().safe().nonnegative(),
      })
      .strict();
    const body = z
      .object({
        date: z.number().int().safe().nonnegative(),
        expected: point.nullable(),
        confirmation: z.literal('CHANGE'),
      })
      .strict()
      .parse(req.body);
    const checkpoint = store.setInboxCheckpoint(body.date, body.expected);
    options.credentials.audit('checkpoint.change', 'success');
    return { checkpoint };
  });
  app.post('/management/tasker/rotate', async req => {
    z.object({ confirmation: z.literal('ROTATE') })
      .strict()
      .parse(req.body);
    return { key: options.credentials.rotate() };
  });
  app.post('/management/tasker/export', async (req, reply) => {
    const body = z
      .object({ origin: z.string().url(), key: z.string().max(200) })
      .strict()
      .parse(req.body);
    if (!options.credentials.isTaskerKey(body.key))
      return reply
        .code(400)
        .send({ error: 'Paste the current restricted Tasker key or rotate it first' });
    return reply
      .type('application/xml')
      .header('content-disposition', 'attachment; filename="Actual_SMS_Inbox.prj.xml"')
      .send(await taskerProject(body.origin, body.key));
  });
}
