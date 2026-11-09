import { describe, expect, it, vi } from 'vitest';
import { open, rename, readFile, readdir, writeFile } from 'node:fs/promises';
import { runtimeFixture } from './fixtures/runtime.js';
import { ConfigEditor } from '../src/config-editor.js';

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open), rename: vi.fn(fs.rename) };
});
const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
describe('atomic account-file failure recovery', () => {
  it.each(['write', 'sync'] as const)(
    'does not publish an incomplete backup after a %s failure and can retry safely',
    async stage => {
      const f = await runtimeFixture();
      try {
        const editor = new ConfigEditor(f.runtime, true),
          initial = await editor.read();
        vi.mocked(open).mockImplementation(async (...args) => {
          const file = await real.open(...args);
          if (String(args[0]).includes('.previous')) {
            if (stage === 'write')
              file.writeFile = async () => {
                throw new Error('Backup write failed');
              };
            else
              file.sync = async () => {
                throw new Error('Backup sync failed');
              };
          }
          return file;
        });
        const candidate = initial.accounts.replace('1234', '4321');
        await expect(editor.save(candidate, initial.revision)).rejects.toThrow(
          `Backup ${stage} failed`,
        );
        expect(await readFile(f.paths.accounts, 'utf8')).toBe(initial.accounts);
        expect(await readdir(f.directory)).not.toContain('accounts.yaml.previous');
        expect((await readdir(f.directory)).some(name => name.endsWith('.tmp'))).toBe(false);
        expect(f.runtime.status().ready).toBe(true);
        vi.mocked(open).mockImplementation(real.open);
        await editor.save(candidate, initial.revision);
        expect(await readFile(f.paths.accounts, 'utf8')).toBe(candidate);
        expect(await readFile(f.paths.accounts + '.previous', 'utf8')).toBe(initial.accounts);
      } finally {
        vi.mocked(open).mockImplementation(real.open);
        await f.cleanup();
      }
    },
  );
  it('never overwrites an existing operator recovery copy', async () => {
    const f = await runtimeFixture();
    try {
      const editor = new ConfigEditor(f.runtime, true),
        initial = await editor.read();
      const backup = '# Protected operator recovery copy\n';
      await writeFile(f.paths.accounts + '.previous', backup);
      await editor.save(initial.accounts.replace('1234', '4321'), initial.revision);
      expect(await readFile(f.paths.accounts + '.previous', 'utf8')).toBe(backup);
      expect((await readdir(f.directory)).some(name => name.endsWith('.tmp'))).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
  it('leaves the original active file intact after a failed replacement', async () => {
    const f = await runtimeFixture();
    try {
      const editor = new ConfigEditor(f.runtime, true),
        initial = await editor.read();
      vi.mocked(rename).mockRejectedValueOnce(new Error('EIO'));
      await expect(
        editor.save(initial.accounts.replace('1234', '4321'), initial.revision),
      ).rejects.toThrow('EIO');
      expect(await readFile(f.paths.accounts, 'utf8')).toBe(initial.accounts);
      expect(f.runtime.status().ready).toBe(true);
      expect((await readdir(f.directory)).some(name => name.endsWith('.tmp'))).toBe(false);
    } finally {
      vi.mocked(rename).mockImplementation(real.rename);
      await f.cleanup();
    }
  });
  it('pauses imports after replacement if directory durability is uncertain, then recovers through reload', async () => {
    const f = await runtimeFixture();
    try {
      const editor = new ConfigEditor(f.runtime, true),
        initial = await editor.read();
      const text = initial.accounts.replace('1234', '4321');
      vi.mocked(open).mockImplementation((...args) => {
        if (String(args[0]) === f.directory)
          return Promise.reject(new Error('Directory sync unavailable'));
        return real.open(...args);
      });
      await expect(editor.save(text, initial.revision)).rejects.toThrow(
        'Directory sync unavailable',
      );
      expect(await readFile(f.paths.accounts, 'utf8')).toBe(text);
      expect(f.runtime.status()).toMatchObject({ ready: false, activeRevision: initial.revision });
      expect(f.runtime.gate.enter()).toBeUndefined();
      vi.mocked(open).mockImplementation(real.open);
      await editor.reload((await editor.read()).revision);
      expect(f.runtime.status().ready).toBe(true);
      expect(f.config.accounts[0]?.match.accountSuffixes).toEqual(['4321']);
    } finally {
      vi.mocked(open).mockImplementation(real.open);
      await f.cleanup();
    }
  });
});
