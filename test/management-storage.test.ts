import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { EventStore } from '../src/db.js';
import { ManagementCredentials } from '../src/management/credentials.js';
import { runtimeFixture } from './fixtures/runtime.js';
import { taskerProject } from '../src/tasker-export.js';
import { loadEnv } from '../src/config.js';

const environment = {
  API_KEY: 'long-enough-legacy-key',
  ACTUAL_SERVER_URL: 'https://actual.example.test',
  ACTUAL_PASSWORD: 'password',
  ACTUAL_SYNC_ID: 'budget',
};
describe('management provisioning and durable phone state', () => {
  it('requires independent explicit management credentials only when enabled', () => {
    expect(loadEnv(environment).MANAGEMENT_ENABLED).toBe(false);
    expect(() => loadEnv({ ...environment, MANAGEMENT_ENABLED: '1' })).toThrow(
      'Management requires',
    );
    expect(() => loadEnv({ ...environment, MANAGEMENT_EDIT_ACCOUNTS: '1' })).toThrow(
      'requires management',
    );
    expect(() => loadEnv({ ...environment, MANAGEMENT_URL: 'http://public.example.test' })).toThrow(
      'HTTPS',
    );
  });
  it('restores checkpoint and restricted-key verification after reopening SQLite', async () => {
    const f = await runtimeFixture();
    try {
      const path = join(f.directory, 'queue.sqlite'),
        first = new EventStore(path);
      const credentials = new ManagementCredentials(first.db),
        key = credentials.rotate(),
        date = Date.now() - 60000;
      first.setInboxCheckpoint(date, null);
      first.close();
      const restored = new EventStore(path);
      try {
        expect(restored.inboxCheckpoint()).toEqual({ date, rowId: 0 });
        expect(new ManagementCredentials(restored.db).isTaskerKey(key)).toBe(true);
        const expected = restored.inboxCheckpoint()!;
        restored.commitInboxBatch(expected, [
          { row: { rowId: 1, date: date + 1000, sender: null, message: null }, skipped: 'empty' },
        ]);
        expect(() => restored.setInboxCheckpoint(date, expected)).toThrow('checkpoint changed');
      } finally {
        restored.close();
      }
    } finally {
      await f.cleanup();
    }
  });
  it('escapes exported XML values and rejects unsafe service origins', async () => {
    expect(await taskerProject('https://sms.example.test', 'a&<b')).toContain(
      '<exportval>a&amp;&lt;b</exportval>',
    );
    for (const origin of [
      'http://sms.example.test',
      'ftp://localhost',
      'https://sms.example.test/path',
      'https://user:pass@sms.example.test',
      'https://sms.example.test?key=bad',
    ])
      await expect(taskerProject(origin, 'key')).rejects.toThrow('HTTPS origin');
  });
});
