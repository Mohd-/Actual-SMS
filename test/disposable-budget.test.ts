import { rm, stat } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  withDisposableBudget,
  type BudgetControl,
  type LifecycleApi,
} from '../scripts/disposable-budget.js';

const caches: string[] = [];
afterEach(async () => {
  await Promise.all(caches.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
function setup(mode = 'success') {
  const remote = [{ fileId: 'production-id', name: 'Existing budget', deleted: false }];
  const local: { id: string; name: string; cloudFileId?: string; groupId?: string }[] = [];
  const send = vi.fn(
    async (name: string, args?: { budgetName?: string; cloudFileId?: string; id?: string }) => {
      switch (name) {
        case 'get-server-version':
          return { version: mode === 'version-mismatch' ? '0.0.0' : '26.11.0' };
        case 'get-remote-files':
          return mode === 'unavailable' ? null : [...remote];
        case 'get-budgets':
          return [...local];
        case 'create-budget':
          local.push({ id: 'new-local-id', name: args!.budgetName! });
          return {};
        case 'upload-budget':
          remote.push({ fileId: 'new-remote-id', name: local[0]!.name, deleted: false });
          if (mode === 'upload-timeout') throw new Error('Upload response lost');
          local[0]!.cloudFileId = 'new-remote-id';
          local[0]!.groupId = 'new-sync-id';
          return {};
        case 'close-budget':
          return 'ok';
        case 'delete-budget':
          if (args?.cloudFileId && mode !== 'delete-failure')
            remote.splice(
              remote.findIndex(file => file.fileId === args.cloudFileId),
              1,
            );
          if (args?.id)
            local.splice(
              local.findIndex(file => file.id === args.id),
              1,
            );
          return 'ok';
        default:
          throw new Error('Unexpected synthetic command');
      }
    },
  );
  const api: LifecycleApi = {
    init: vi.fn(async options => {
      caches.push(options!.dataDir!);
      return { send: send as unknown as BudgetControl['send'] };
    }),
    shutdown: vi.fn(async () => {}),
  };
  return { api, send, remote, local };
}
const options = {
  serverURL: 'http://actual.example.test',
  password: 'synthetic-password',
  protectedSyncId: 'production-id',
};

describe('disposable budget lifecycle', () => {
  it('uses a new cache and deletes only the new budget, verifying cleanup independently', async () => {
    const { api, send, remote, local } = setup();
    await withDisposableBudget(api, options, async context => {
      expect(context.syncId).toBe('new-sync-id');
      expect(context.name).toMatch(/^actual-sms-smoke-/);
      expect((await stat(context.cacheDir)).mode & 0o777).toBe(0o700);
    });
    expect(send.mock.calls.filter(([name]) => name === 'delete-budget')).toEqual([
      ['delete-budget', { cloudFileId: 'new-remote-id', id: 'new-local-id' }],
    ]);
    expect(remote.map(file => file.fileId)).toEqual(['production-id']);
    expect(local).toEqual([]);
    expect(api.shutdown).toHaveBeenCalledOnce();
    await expect(stat(caches[0]!)).rejects.toThrow();
  });
  it('cleans up even if the live assertions fail', async () => {
    const { api, remote } = setup();
    await expect(
      withDisposableBudget(api, options, async () => {
        throw new Error('Synthetic assertion failed');
      }),
    ).rejects.toThrow('Synthetic assertion failed');
    expect(remote.map(file => file.fileId)).toEqual(['production-id']);
  });
  it('discovers and removes its own upload if the response is lost', async () => {
    const { api, remote } = setup('upload-timeout');
    await expect(withDisposableBudget(api, options, async () => {})).rejects.toThrow(
      'Upload response lost',
    );
    expect(remote.map(file => file.fileId)).toEqual(['production-id']);
  });
  it.each(['unavailable', 'version-mismatch'])(
    'does not create or delete budgets when the server is %s',
    async mode => {
      const { api, send } = setup(mode);
      await expect(withDisposableBudget(api, options, async () => {})).rejects.toThrow();
      expect(
        send.mock.calls.some(([name]) => name === 'create-budget' || name === 'delete-budget'),
      ).toBe(false);
    },
  );
  it('detects a silently failed remote deletion and retains the recovery cache', async () => {
    const { api, remote } = setup('delete-failure');
    await expect(withDisposableBudget(api, options, async () => {})).rejects.toThrow(
      'Disposable smoke cleanup failed',
    );
    expect(remote.map(file => file.fileId)).toEqual(['production-id', 'new-remote-id']);
    expect((await stat(caches[0]!)).mode & 0o777).toBe(0o700);
  });
});
