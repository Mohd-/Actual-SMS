import { afterEach, describe, expect, it, vi } from 'vitest';
import { hash } from 'bcryptjs';
import { runtimeFixture } from './fixtures/runtime.js';
import { ConfigEditor } from '../src/config-editor.js';
import { EventStore } from '../src/db.js';
import { ManagementCredentials } from '../src/management/credentials.js';
import { buildServer } from '../src/server.js';
import type { Processor } from '../src/processor.js';

const cleanup: (() => Promise<unknown>)[] = [];
const origin = 'http://localhost:3000';
const sessionCookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers['set-cookie']).split(';')[0]!;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});
export async function managementFixture() {
  const f = await runtimeFixture();
  cleanup.push(f.cleanup);
  const store = new EventStore(':memory:');
  const credentials = new ManagementCredentials(store.db);
  const app = buildServer({
    apiKey: 'legacy-api-key',
    banks: () => f.config.banks,
    store,
    processor: { tick: async () => {} } as Processor,
    ready: () => f.runtime.status().ready,
    management: {
      runtime: f.runtime,
      editor: new ConfigEditor(f.runtime, true),
      credentials,
      origin: 'http://localhost:3000',
      secret: 'ab'.repeat(32),
      passwordHash: await hash('test-password', 4),
    },
  });
  cleanup.push(async () => {
    await app.close();
    store.close();
  });
  const login = () =>
    app.inject({
      method: 'POST',
      url: '/management/login',
      headers: { origin: 'http://localhost:3000' },
      payload: { password: 'test-password' },
    });
  return { ...f, store, credentials, app, login };
}
describe('optional management authorization', () => {
  it('reports a failed live validation without claiming a successful config save', async () => {
    const f = await managementFixture();
    const cookie = sessionCookie(await f.login());
    const view = (
      await f.app.inject({ url: '/management/config', headers: { cookie } })
    ).json() as { accounts: string; revision: string };
    f.actual.sync = async () => {
      throw new Error('private-sync-password');
    };
    const response = await f.app.inject({
      method: 'POST',
      url: '/management/config/save',
      headers: { cookie, origin },
      payload: {
        accounts: view.accounts.replace('1234', '4321'),
        revision: view.revision,
        confirmation: 'SAVE',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('private-sync-password');
    const persisted = (
      await f.app.inject({ url: '/management/config', headers: { cookie } })
    ).json() as { accounts: string; revision: string; activeRevision: string };
    expect(persisted.accounts).toBe(view.accounts);
    expect(persisted.revision).toBe(view.revision);
    expect(persisted.activeRevision).toBe(view.revision);
    expect((await f.app.inject({ url: '/readyz' })).statusCode).toBe(503);
    const status = await f.app.inject({ url: '/management/status', headers: { cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      ready: false,
      error: expect.stringContaining('Actual synchronization failed'),
    });
    expect(status.body).not.toContain('private-sync-password');
    expect(
      f.store.db.prepare("SELECT outcome FROM management_audit WHERE action='config.save'").all(),
    ).toEqual([{ outcome: 'failed' }]);
    f.actual.sync = async () => {};
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/management/config/reload',
          headers: { cookie, origin },
          payload: { revision: view.revision },
        })
      ).statusCode,
    ).toBe(200);
    expect((await f.app.inject({ url: '/readyz' })).statusCode).toBe(200);
  });
  it('requires a browser session and exact origin, not an ingestion key', async () => {
    const { app, login } = await managementFixture();
    expect(
      (await app.inject({ url: '/management/status', headers: { 'x-api-key': 'legacy-api-key' } }))
        .statusCode,
    ).toBe(401);
    const signedIn = await login();
    expect(signedIn.statusCode).toBe(200);
    const cookie = sessionCookie(signedIn);
    expect((await app.inject({ url: '/management/status', headers: { cookie } })).statusCode).toBe(
      200,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/management/reconnect',
          headers: { cookie, origin: 'https://evil.test' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ url: '/v1/events', headers: { cookie } })).statusCode).toBe(401);
  });
  it('revokes sessions server-side and sends protective headers', async () => {
    const { app, login } = await managementFixture();
    const loggedIn = await login(),
      cookie = sessionCookie(loggedIn);
    expect(loggedIn.headers['set-cookie']).toContain('HttpOnly');
    expect(loggedIn.headers['set-cookie']).toContain('SameSite=Strict');
    const status = await app.inject({ url: '/management/status', headers: { cookie } });
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.headers['content-security-policy']).toContain("script-src 'self'");
    await app.inject({
      method: 'POST',
      url: '/management/logout',
      headers: { cookie, origin },
      payload: {},
    });
    expect((await app.inject({ url: '/management/status', headers: { cookie } })).statusCode).toBe(
      401,
    );
  });
  it('throttles login attempts despite changing forwarded headers', async () => {
    const { app } = await managementFixture();
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/management/login',
            headers: { origin, 'x-forwarded-for': `192.0.2.${attempt}` },
            payload: { password: 'incorrect' },
          })
        ).statusCode,
      ).toBe(401);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/management/login',
          headers: { origin, 'x-forwarded-for': '192.0.2.99' },
          payload: { password: 'incorrect' },
        })
      ).statusCode,
    ).toBe(429);
  });
  it('keeps summaries private and unknown-sender inbox content discarded', async () => {
    const { app, store, login } = await managementFixture();
    const cookie = sessionCookie(await login());
    const start = await app.inject({
      method: 'POST',
      url: '/v1/inbox-sync/start',
      headers: { 'x-api-key': 'legacy-api-key' },
    });
    const checkpoint = start.json().checkpoint as { date: number; rowId: number };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/inbox-sync/batch',
      headers: { 'x-api-key': 'legacy-api-key' },
      payload: {
        checkpoint,
        rows: [
          {
            rowId: 1,
            date: checkpoint.date + 1000,
            sender: 'UNKNOWN',
            message: 'personal-message',
          },
          {
            rowId: 2,
            date: checkpoint.date + 2000,
            sender: 'SAB',
            message: 'bank-private-message',
          },
        ],
      },
    });
    expect(response.statusCode).toBe(202);
    expect(store.counts()).toEqual([{ status: 'queued', count: 1 }]);
    const list = await app.inject({ url: '/management/events', headers: { cookie } });
    expect(list.body).not.toContain('bank-private-message');
    expect(list.body).not.toContain('personal-message');
    const event = store.list({ limit: 1 })[0]!;
    expect(
      (await app.inject({ url: `/management/events/${event.id}`, headers: { cookie } })).body,
    ).toContain('bank-private-message');
  });
  it('restricts Tasker keys, rotates explicitly, and preserves the legacy key', async () => {
    const { app, credentials, login } = await managementFixture();
    const cookie = sessionCookie(await login());
    const rotate = () =>
      app.inject({
        method: 'POST',
        url: '/management/tasker/rotate',
        headers: { cookie, origin },
        payload: { confirmation: 'ROTATE' },
      });
    const first = (await rotate()).json().key as string;
    expect(credentials.isTaskerKey(first)).toBe(true);
    expect(
      (await app.inject({ url: '/v1/events', headers: { 'x-api-key': first } })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: '/management/status', headers: { 'x-api-key': first } })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/inbox-sync/start',
          headers: { 'x-api-key': first },
        })
      ).statusCode,
    ).toBe(200);
    const download = await app.inject({
      method: 'POST',
      url: '/management/tasker/export',
      headers: { cookie, origin },
      payload: { origin: 'https://sms.example.test', key: first },
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toContain(`<exportval>${first}</exportval>`);
    expect(download.body).toContain('/v1/inbox-sync/batch');
    await rotate();
    expect(credentials.isTaskerKey(first)).toBe(false);
    expect(
      (await app.inject({ url: '/v1/events', headers: { 'x-api-key': 'legacy-api-key' } }))
        .statusCode,
    ).toBe(200);
  });
  it('does not initialize the checkpoint when viewing config or exporting', async () => {
    const { app, store, credentials, login } = await managementFixture();
    const cookie = sessionCookie(await login());
    const key = credentials.rotate();
    expect(
      (await app.inject({ url: '/management/tasker/checkpoint', headers: { cookie } })).json(),
    ).toEqual({ checkpoint: null });
    await app.inject({
      method: 'POST',
      url: '/management/tasker/export',
      headers: { cookie, origin },
      payload: { origin: 'https://sms.example.test', key },
    });
    expect(store.inboxCheckpoint()).toBeUndefined();
    const date = Date.now() - 3600000;
    const update = await app.inject({
      method: 'POST',
      url: '/management/tasker/checkpoint',
      headers: { cookie, origin },
      payload: { date, expected: null, confirmation: 'CHANGE' },
    });
    expect(update.statusCode).toBe(200);
    expect(store.inboxCheckpoint()).toEqual({ date, rowId: 0 });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/management/tasker/checkpoint',
          headers: { cookie, origin },
          payload: { date, expected: null, confirmation: 'CHANGE' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/management/tasker/checkpoint',
          headers: { cookie, origin },
          payload: {
            date: Date.now() + 60000,
            expected: { date, rowId: 0 },
            confirmation: 'CHANGE',
          },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('expires sessions and paginates metadata without revealing message bodies', async () => {
    const { app, store, login } = await managementFixture();
    const cookie = sessionCookie(await login());
    for (let i = 0; i < 5; i++)
      store.enqueue({
        eventId: `pagination-${i}`,
        message: 'private-body',
        receivedAt: '2026-08-22T10:00:00Z',
      });
    const first = (
      await app.inject({ url: '/management/events?limit=2', headers: { cookie } })
    ).json() as { events: { eventId: string }[]; nextCursor: string };
    const second = (
      await app.inject({
        url: `/management/events?limit=2&cursor=${first.nextCursor}`,
        headers: { cookie },
      })
    ).json() as { events: { eventId: string }[] };
    expect(new Set([...first.events, ...second.events].map(e => e.eventId)).size).toBe(4);
    expect(JSON.stringify(first)).not.toContain('private-body');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 9 * 3600000);
    expect((await app.inject({ url: '/management/status', headers: { cookie } })).statusCode).toBe(
      401,
    );
  });
  it('keeps restricted phone credentials usable when management is disabled', async () => {
    const f = await managementFixture(),
      key = f.credentials.rotate();
    const headless = buildServer({
      apiKey: 'legacy',
      banks: f.config.banks,
      store: f.store,
      processor: { tick: async () => {} } as Processor,
      ready: () => true,
      taskerCredentials: f.credentials,
    });
    try {
      expect(
        (
          await headless.inject({
            method: 'POST',
            url: '/v1/inbox-sync/start',
            headers: { 'x-api-key': key },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await headless.inject({ url: '/v1/events', headers: { 'x-api-key': key } })).statusCode,
      ).toBe(403);
      expect((await headless.inject({ url: '/manage' })).statusCode).toBe(401);
    } finally {
      await headless.close();
    }
  });
  it('saves YAML only after explicit confirmation and validation', async () => {
    const { app, login, config } = await managementFixture();
    const cookie = sessionCookie(await login());
    const view = (await app.inject({ url: '/management/config', headers: { cookie } })).json() as {
      accounts: string;
      revision: string;
    };
    const edit = { accounts: view.accounts.replace('1234', '4321'), revision: view.revision };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/management/config/save',
          headers: { cookie, origin },
          payload: edit,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/management/config/preview',
          headers: { cookie, origin },
          payload: edit,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/management/config/save',
          headers: { cookie, origin },
          payload: { ...edit, confirmation: 'SAVE' },
        })
      ).statusCode,
    ).toBe(200);
    expect(config.accounts[0]?.match.accountSuffixes).toEqual(['4321']);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/management/config/save',
          headers: { cookie, origin },
          payload: { ...edit, confirmation: 'SAVE' },
        })
      ).statusCode,
    ).toBe(409);
  });
});
