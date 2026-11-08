import { lstat, realpath, open, rename, unlink, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Runtime } from './runtime.js';
import { configRevision, readConfigFiles } from './runtime-config.js';

export class ConfigConflict extends Error {
  constructor() {
    super('Configuration changed; reload before saving');
  }
}
export class ConfigEditor {
  constructor(
    private runtime: Runtime,
    private editable = false,
  ) {}
  private async checkPath() {
    const path = resolve(this.runtime.paths.accounts);
    const info = await lstat(path);
    if (!info.isFile() || (await realpath(path)) !== path)
      throw new Error('Account configuration must be a regular file without symlinks');
    return info;
  }
  async read() {
    await this.checkPath();
    const files = await readConfigFiles(this.runtime.paths);
    let writable = this.editable;
    if (writable)
      await access(dirname(this.runtime.paths.accounts), constants.W_OK).catch(() => {
        writable = false;
      });
    return {
      ...files,
      revision: configRevision(files),
      activeRevision: this.runtime.status().activeRevision,
      editable: writable,
    };
  }
  async preview(accounts: string, expected: string) {
    return this.runtime.withConfiguration(async validate => {
      const current = await this.read();
      if (current.revision !== expected) throw new ConfigConflict();
      await validate({ ...current, accounts });
      return { valid: true, revision: expected };
    });
  }
  async reload(expected: string) {
    return this.runtime.withConfiguration(async validate => {
      const current = await this.read();
      if (current.revision !== expected) throw new ConfigConflict();
      const snapshot = await validate(current);
      if ((await this.read()).revision !== expected) throw new ConfigConflict();
      this.runtime.activate(current, snapshot);
      return this.read();
    });
  }
  async save(accounts: string, expected: string) {
    if (!this.editable) throw new Error('Configuration is read-only');
    return this.runtime.withConfiguration(async validate => {
      const current = await this.read();
      if (!current.editable) throw new Error('Configuration directory is read-only');
      if (current.revision !== expected) throw new ConfigConflict();
      const candidate = { accounts, banks: current.banks, parsing: current.parsing };
      const snapshot = await validate(candidate);
      const info = await this.checkPath();
      if ((await this.read()).revision !== expected) throw new ConfigConflict();
      const path = this.runtime.paths.accounts;
      const temporary = `${path}.${randomUUID()}.tmp`;
      const backup = `${path}.previous`;
      let committed = false;
      try {
        // Exclusive creation rejects backup symlinks and never overwrites an operator's copy.
        const previous = await open(backup, 'wx', 0o600).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
          throw error;
        });
        if (previous) {
          try {
            await previous.writeFile(current.accounts);
            await previous.sync();
          } finally {
            await previous.close();
          }
        }
        const file = await open(temporary, 'wx', info.mode & 0o777);
        try {
          const temporaryInfo = await file.stat();
          if (temporaryInfo.uid !== info.uid || temporaryInfo.gid !== info.gid)
            await file.chown(info.uid, info.gid);
          await file.chmod(info.mode & 0o777);
          await file.writeFile(accounts);
          await file.sync();
        } finally {
          await file.close();
        }
        if ((await this.read()).revision !== expected) throw new ConfigConflict();
        await rename(temporary, path);
        committed = true;
        const directory = await open(dirname(path), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        if ((await this.read()).revision !== configRevision(candidate)) throw new ConfigConflict();
        this.runtime.activate(candidate, snapshot);
        return this.read();
      } catch (error) {
        if (committed)
          this.runtime.hold(
            'Configuration saved but activation is uncertain; inspect files and reload.',
          );
        throw error;
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
  }
}
