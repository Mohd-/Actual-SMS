import { describe, expect, it } from 'vitest';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { ConfigEditor } from '../src/config-editor.js';
import { EventStore } from '../src/db.js';
import { Processor } from '../src/processor.js';
import { NoopEnricher } from '../src/enricher.js';
import { runtimeFixture } from './fixtures/runtime.js';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}

describe('connected configuration validation', () => {
  it.each(['import', 'mapping refresh'] as const)(
    'waits for an active %s before validating and saving',
    async operation => {
      const f = await runtimeFixture(),
        store = new EventStore(':memory:'),
        started = deferred(),
        activeWork = deferred();
      try {
        const editor = new ConfigEditor(f.runtime, true),
          initial = await editor.read();
        let active = true,
          reads = 0;
        if (operation === 'import')
          f.actual.importTransactions = async () => {
            started.release();
            await activeWork.promise;
            active = false;
            return { added: ['written'], updated: [], errors: [] };
          };
        else
          f.actual.sync = async () => {
            if (active) {
              started.release();
              await activeWork.promise;
              active = false;
            }
          };
        f.actual.accounts = async () => {
          expect(active).toBe(false);
          reads++;
          return [{ id: 'checking', name: 'Checking' }];
        };
        const processor = new Processor(
          store,
          f.actual,
          new NoopEnricher(),
          f.config,
          5,
          0.7,
          undefined,
          f.runtime.gate,
        );
        store.enqueue({
          sender: 'SAB',
          message: 'Purchase Card:1234 Amount: SAR 10 at Coffee',
          receivedAt: '2026-08-22T10:00:00+03:00',
        });
        const work = operation === 'import' ? processor.tick() : processor.refreshMappings();
        await started.promise;
        const save = editor.save(initial.accounts.replace('1234', '4321'), initial.revision);
        expect(reads).toBe(0);
        expect(f.runtime.status().ready).toBe(false);
        await expect(f.runtime.reconnect()).rejects.toThrow('in progress');
        activeWork.release();
        await work;
        await save;
        expect(reads).toBe(1);
        expect(f.config.accounts[0]?.match.accountSuffixes).toEqual(['4321']);
        expect(await readFile(f.paths.accounts, 'utf8')).toContain('4321');
        expect(f.runtime.status().ready).toBe(true);
      } finally {
        activeWork.release();
        store.close();
        await f.cleanup();
      }
    },
  );
  it.each([
    'removed account',
    'renamed account',
    'ambiguous account',
    'removed category',
    'hidden category',
    'income category',
  ])('rejects a remotely %s after syncing instead of accepting the old cache', async scenario => {
    const f = await runtimeFixture();
    try {
      const editor = new ConfigEditor(f.runtime, true),
        initial = await editor.read();
      let fresh = false;
      f.actual.sync = async () => {
        fresh = true;
      };
      f.actual.accounts = async () =>
        fresh && scenario.includes('account')
          ? scenario === 'ambiguous account'
            ? [
                { id: 'a', name: 'Checking' },
                { id: 'b', name: 'Checking' },
              ]
            : scenario === 'renamed account'
              ? [{ id: 'checking', name: 'Renamed' }]
              : []
          : [{ id: 'checking', name: 'Checking' }];
      f.actual.categories = async () =>
        fresh && scenario.includes('category')
          ? scenario === 'removed category'
            ? []
            : [
                {
                  id: 'fees',
                  name: 'Fees',
                  hidden: scenario === 'hidden category',
                  isIncome: scenario === 'income category',
                },
              ]
          : [{ id: 'fees', name: 'Fees' }];
      await expect(
        editor.save(initial.accounts.replace('1234', '4321'), initial.revision),
      ).rejects.toThrow('exactly once');
      expect(fresh).toBe(true);
      expect(await readFile(f.paths.accounts, 'utf8')).toBe(initial.accounts);
      expect(f.runtime.status()).toMatchObject({ ready: true, activeRevision: initial.revision });
      expect(f.config.accounts[0]?.match.accountSuffixes).toEqual(['1234']);
    } finally {
      await f.cleanup();
    }
  });

  it('rejects schema errors without attempting a sync or pausing a healthy importer', async () => {
    const f = await runtimeFixture();
    try {
      const editor = new ConfigEditor(f.runtime, true),
        initial = await editor.read();
      let synced = false;
      f.actual.sync = async () => {
        synced = true;
        throw new Error('Server unavailable');
      };
      await expect(
        editor.save(initial.accounts.replace('bank: sab', 'bank: missing'), initial.revision),
      ).rejects.toThrow('Unknown bank');
      expect(synced).toBe(false);
      expect(f.runtime.status().ready).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it('keeps validation inside the work gate and drains it before shutting down the adapter', async () => {
    const f = await runtimeFixture(),
      store = new EventStore(':memory:'),
      started = deferred(),
      sync = deferred();
    try {
      const editor = new ConfigEditor(f.runtime, true),
        initial = await editor.read();
      let closed = false,
        syncCalls = 0;
      f.actual.shutdown = async () => {
        closed = true;
      };
      f.actual.sync = async () => {
        syncCalls++;
        started.release();
        await sync.promise;
      };
      const processor = new Processor(
        store,
        f.actual,
        new NoopEnricher(),
        f.config,
        5,
        0.7,
        undefined,
        f.runtime.gate,
      );
      const { id } = store.enqueue({
        sender: 'SAB',
        message: 'Purchase Card:1234 Amount: SAR 10 at Coffee',
        receivedAt: '2026-08-22T10:00:00+03:00',
      });
      const preview = editor.preview(initial.accounts, initial.revision);
      await started.promise;
      await processor.tick();
      await processor.refreshMappings();
      expect(syncCalls).toBe(1);
      expect(store.get(id)).toMatchObject({ status: 'queued', attempts: 0 });
      await expect(f.runtime.reconnect()).rejects.toThrow('in progress');
      const stop = f.runtime.shutdown();
      expect(closed).toBe(false);
      expect(f.runtime.status().ready).toBe(false);
      sync.release();
      await preview;
      await stop;
      expect(closed).toBe(true);
    } finally {
      sync.release();
      store.close();
      await f.cleanup();
    }
  });

  it('rechecks dependency revisions after connected validation and before replacing disk', async () => {
    const f = await runtimeFixture();
    try {
      const editor = new ConfigEditor(f.runtime, true),
        initial = await editor.read();
      f.actual.sync = async () => {
        await writeFile(f.paths.banks, initial.banks + '\n# External edit during sync\n');
      };
      await expect(
        editor.save(initial.accounts.replace('1234', '4321'), initial.revision),
      ).rejects.toThrow('changed');
      expect(await readFile(f.paths.accounts, 'utf8')).toBe(initial.accounts);
      expect(f.runtime.status()).toMatchObject({ ready: true, activeRevision: initial.revision });
    } finally {
      await f.cleanup();
    }
  });
  it.each(['preview', 'save', 'reload'] as const)(
    'rejects %s against cached objects during a sync outage without changing disk or active state',
    async operation => {
      const f = await runtimeFixture(),
        store = new EventStore(':memory:');
      try {
        const editor = new ConfigEditor(f.runtime, true),
          before = await editor.read();
        const mode = (await stat(f.paths.accounts)).mode;
        const files = await readdir(f.directory),
          snapshot = structuredClone(f.config);
        f.actual.sync = async () => {
          throw new Error('private-connection-password');
        };
        const candidate = before.accounts.replace('1234', '4321');
        await expect(
          operation === 'reload'
            ? editor.reload(before.revision)
            : editor[operation](candidate, before.revision),
        ).rejects.toThrow('Actual');
        expect(await readFile(f.paths.accounts, 'utf8')).toBe(before.accounts);
        expect((await stat(f.paths.accounts)).mode).toBe(mode);
        expect(await readdir(f.directory)).toEqual(files);
        expect(f.config).toEqual(snapshot);
        expect(f.runtime.status()).toMatchObject({
          ready: false,
          activeRevision: before.activeRevision,
        });
        expect(JSON.stringify(f.runtime.status())).not.toContain('private-connection-password');
        const { id } = store.enqueue({
          sender: 'SAB',
          message: 'Purchase Card:1234 Amount: SAR 10 at Coffee',
          receivedAt: '2026-08-22T10:00:00+03:00',
        });
        await new Processor(
          store,
          f.actual,
          new NoopEnricher(),
          f.config,
          5,
          0.7,
          undefined,
          f.runtime.gate,
        ).tick();
        expect(store.get(id)).toMatchObject({ status: 'queued', attempts: 0 });
        f.actual.sync = async () => {};
        await editor.reload(before.revision);
        expect(f.runtime.status().ready).toBe(true);
      } finally {
        store.close();
        await f.cleanup();
      }
    },
  );
});
