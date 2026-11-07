import { describe, expect, it } from 'vitest';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveConfig, readConfigFiles } from '../src/runtime-config.js';
import { runtimeFixture } from './fixtures/runtime.js';
import { ConfigEditor } from '../src/config-editor.js';

describe('YAML account editing', () => {
  it('preserves exact text and activates the same rules as a fresh YAML load', async () => {
    const f = await runtimeFixture();
    try {
      const editor = new ConfigEditor(f.runtime, true);
      const initial = await editor.read();
      const text = initial.accounts.replace('1234', '4321') + '# End comment\n';
      await editor.save(text, initial.revision);
      expect(await readFile(f.paths.accounts, 'utf8')).toBe(text);
      expect(f.config.accounts[0]?.match.accountSuffixes).toEqual(['4321']);
      expect((await editor.read()).activeRevision).toBe((await editor.read()).revision);
      expect(await resolveConfig(await readConfigFiles(f.paths), f.actual)).toEqual(f.config);
      const restarted = new ConfigEditor(f.runtime, false);
      await expect(restarted.save(text, initial.revision)).rejects.toThrow('read-only');
    } finally {
      await f.cleanup();
    }
  });
  it('rejects a stale editor after an external account or dependency edit', async () => {
    const f = await runtimeFixture();
    try {
      const editor = new ConfigEditor(f.runtime, true),
        initial = await editor.read();
      await writeFile(f.paths.banks, initial.banks + '\n# External change\n');
      await expect(editor.save(initial.accounts, initial.revision)).rejects.toThrow('changed');
      expect(await readFile(f.paths.accounts, 'utf8')).toBe(initial.accounts);
      expect(f.runtime.status().activeRevision).toBe(initial.revision);
    } finally {
      await f.cleanup();
    }
  });
  it('rejects invalid names and overlapping rules before modifying disk', async () => {
    const f = await runtimeFixture();
    try {
      const editor = new ConfigEditor(f.runtime, true),
        initial = await editor.read();
      await expect(
        editor.save(initial.accounts.replace('Checking', 'Missing'), initial.revision),
      ).rejects.toThrow('exactly once');
      await expect(
        editor.save(
          initial.accounts.replace(
            'bankFeesCategory:',
            '  - actualName: Checking\n    match:\n      bank: sab\n      accountSuffixes: ["1234"]\nbankFeesCategory:',
          ),
          initial.revision,
        ),
      ).rejects.toThrow('Ambiguous');
      expect(await readFile(f.paths.accounts, 'utf8')).toBe(initial.accounts);
      expect(f.runtime.status().ready).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
  it('keeps multiple rules per account and unrelated YAML fields unchanged', async () => {
    const f = await runtimeFixture();
    try {
      const editor = new ConfigEditor(f.runtime, true),
        initial = await editor.read();
      const text = initial.accounts.replace(
        'bankFeesCategory:',
        '  - actualName: Checking\n    match:\n      bank: sab\n      accountSuffixes: ["5678"]\n      transactionKinds: [purchase]\n      hasBalance: true\n      transferIdentifiers: ["9876"]\n      billPaymentIdentifiers: ["404"]\nprivateOperatorNote: keep-me\nbankFeesCategory:',
      );
      await editor.save(text, initial.revision);
      expect(f.config.accounts).toHaveLength(2);
      expect(await readFile(f.paths.accounts, 'utf8')).toBe(text);
      expect(await readFile(f.paths.accounts + '.previous', 'utf8')).toBe(initial.accounts);
    } finally {
      await f.cleanup();
    }
  });
  it('does not activate invalid external edits and can explicitly reload valid ones', async () => {
    const f = await runtimeFixture();
    try {
      const editor = new ConfigEditor(f.runtime, true),
        initial = await editor.read();
      await writeFile(f.paths.accounts, initial.accounts.replace('Checking', 'Missing'));
      let disk = await editor.read();
      await expect(editor.reload(disk.revision)).rejects.toThrow('exactly once');
      expect(f.config.accounts[0]?.name).toBe('Checking');
      await writeFile(f.paths.accounts, initial.accounts.replace('1234', '6789'));
      disk = await editor.read();
      await editor.reload(disk.revision);
      expect((await editor.read()).activeRevision).toBe(disk.revision);
      expect(f.config.accounts[0]?.match.accountSuffixes).toEqual(['6789']);
    } finally {
      await f.cleanup();
    }
  });
  it('rejects symlink targets instead of editing an arbitrary file', async () => {
    const f = await runtimeFixture();
    try {
      const link = join(f.directory, 'link.yaml');
      await symlink(f.paths.accounts, link);
      f.paths.accounts = link;
      await expect(new ConfigEditor(f.runtime, true).read()).rejects.toThrow('without symlinks');
    } finally {
      await f.cleanup();
    }
  });
});
