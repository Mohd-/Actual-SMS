import { describe, expect, it, vi } from 'vitest';
import { runtimeFixture } from './fixtures/runtime.js';
import { Processor } from '../src/processor.js';
import { EventStore } from '../src/db.js';
import { NoopEnricher } from '../src/enricher.js';
import { ConfigurationError } from '../src/runtime-config.js';
import { Runtime } from '../src/runtime.js';
import { readFile, writeFile } from 'node:fs/promises';
import { ConfigEditor } from '../src/config-editor.js';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}
describe('configured runtime lifecycle', () => {
  it('keeps maintenance startup disconnected without touching the Actual adapter', async () => {
    const f = await runtimeFixture();
    try {
      const runtime = new Runtime(f.actual, f.config, f.paths);
      const sync = vi.spyOn(f.actual, 'sync');
      const shutdown = vi.spyOn(f.actual, 'shutdown');
      const initialize = vi.spyOn(f.actual, 'initialize');
      runtime.beginShutdown();
      await runtime.shutdown();
      await runtime.shutdown();
      await expect(runtime.reconnect()).rejects.toThrow('shutting down');
      expect(runtime.status().ready).toBe(false);
      expect(sync).not.toHaveBeenCalled();
      expect(shutdown).not.toHaveBeenCalled();
      expect(initialize).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });
  it('allows process shutdown after maintenance without closing Actual twice', async () => {
    const f = await runtimeFixture();
    try {
      const sync = vi.spyOn(f.actual, 'sync');
      const shutdown = vi.spyOn(f.actual, 'shutdown');
      await f.runtime.shutdown();
      await f.runtime.shutdown();
      expect(f.runtime.status().ready).toBe(false);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });
  it('does not claim new work after stopping the processor', async () => {
    const f = await runtimeFixture();
    const store = new EventStore(':memory:');
    try {
      const processor = new Processor(store, f.actual, new NoopEnricher(), f.config);
      await processor.stop();
      store.enqueue({
        eventId: 'after-stop',
        sender: 'SAB',
        message: 'Purchase Card:1234 Amount: SAR 10 at Coffee',
        receivedAt: '2026-08-22T10:00:00+03:00',
      });
      await processor.tick();
      expect(store.get('after-stop')).toMatchObject({ status: 'queued', attempts: 0 });
      expect(store.eventHistory('after-stop')).toHaveLength(1);
    } finally {
      store.close();
      await f.cleanup();
    }
  });
  it('keeps imports paused when the configured Actual version does not match', async () => {
    const f = await runtimeFixture();
    try {
      f.actual.serverVersion = async () => '0.0.0';
      await expect(f.runtime.reconnect()).rejects.toThrow('Actual connection');
      expect(f.runtime.status().ready).toBe(false);
      expect(f.runtime.gate.enter()).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });
  it('pauses queued imports during a connection outage without consuming attempts', async () => {
    const f = await runtimeFixture(),
      store = new EventStore(':memory:');
    try {
      f.actual.initialize = async () => {
        throw new Error('password-sensitive-error');
      };
      await expect(f.runtime.reconnect()).rejects.toThrow('Actual connection');
      expect(JSON.stringify(f.runtime.status())).not.toContain('password-sensitive');
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
      await processor.tick();
      expect(store.get(id)).toMatchObject({ status: 'queued', attempts: 0 });
      f.actual.initialize = async () => {};
      await f.runtime.reconnect();
      await processor.tick();
      expect(store.get(id)?.status).toBe('imported');
    } finally {
      store.close();
      await f.cleanup();
    }
  });
  it('does not close an adapter while an import is in flight', async () => {
    const f = await runtimeFixture(),
      store = new EventStore(':memory:'),
      started = deferred(),
      write = deferred();
    try {
      let closed = false;
      f.actual.shutdown = async () => {
        closed = true;
      };
      f.actual.importTransactions = async () => {
        started.release();
        await write.promise;
        return { added: ['written'], updated: [], errors: [] };
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
      const tick = processor.tick();
      await started.promise;
      const reconnect = f.runtime.reconnect();
      expect(f.runtime.status().ready).toBe(false);
      expect(closed).toBe(false);
      await expect(f.runtime.reconnect()).rejects.toThrow('in progress');
      write.release();
      await tick;
      await reconnect;
      expect(closed).toBe(true);
      expect(f.runtime.status().ready).toBe(true);
    } finally {
      write.release();
      store.close();
      await f.cleanup();
    }
  });
  it('drains mapping refreshes and permanently blocks work after shutdown', async () => {
    const f = await runtimeFixture(),
      store = new EventStore(':memory:'),
      started = deferred(),
      sync = deferred();
    try {
      let closed = false;
      f.actual.shutdown = async () => {
        closed = true;
      };
      f.actual.sync = async () => {
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
      const refresh = processor.refreshMappings();
      await started.promise;
      const stop = f.runtime.shutdown();
      expect(closed).toBe(false);
      expect(f.runtime.gate.enter()).toBeUndefined();
      sync.release();
      await refresh;
      await stop;
      expect(closed).toBe(true);
      await expect(f.runtime.reconnect()).rejects.toThrow('shutting down');
    } finally {
      sync.release();
      store.close();
      await f.cleanup();
    }
  });
  it('rejects configuration edits racing reconnect and detects external edits during connection', async () => {
    const f = await runtimeFixture(),
      started = deferred(),
      connecting = deferred();
    try {
      const editor = new ConfigEditor(f.runtime, true),
        initial = await editor.read();
      f.actual.initialize = async () => {
        started.release();
        await connecting.promise;
      };
      const reconnect = f.runtime.reconnect();
      await started.promise;
      await expect(editor.save(initial.accounts, initial.revision)).rejects.toThrow('in progress');
      await writeFile(
        f.paths.accounts,
        (await readFile(f.paths.accounts, 'utf8')).replace('1234', '4321'),
      );
      connecting.release();
      await expect(reconnect).rejects.toThrow('changed during connection');
      expect(f.runtime.status().ready).toBe(false);
      expect(f.config.accounts[0]?.match.accountSuffixes).toEqual(['1234']);
      f.actual.initialize = async () => {};
      await f.runtime.reconnect();
      expect(f.config.accounts[0]?.match.accountSuffixes).toEqual(['4321']);
    } finally {
      connecting.release();
      await f.cleanup();
    }
  });
  it('fails configuration resolution rather than silently deleting invalid routes', async () => {
    const f = await runtimeFixture();
    try {
      f.actual.accounts = async () => [];
      await expect(f.runtime.reconnect()).rejects.toBeInstanceOf(ConfigurationError);
      expect(f.runtime.status().ready).toBe(false);
      expect(f.config.accounts).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });
});
