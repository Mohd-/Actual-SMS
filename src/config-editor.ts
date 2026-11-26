import { lstat, realpath, open, rename, link, unlink, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Runtime } from './runtime.js';
import type { ConfigFiles } from './runtime-config.js';
import { configRevision, readConfigFiles } from './runtime-config.js';

export type EditableConfigFile = 'accounts' | 'banks' | 'parsing';

export class ConfigConflict extends Error {
  constructor() {
    super('Configuration changed; reload before saving');
  }
}
export class ConfigEditor {
  constructor(
    private runtime: Runtime,
    private editable = false,
    private editableBanks = false,
    private editableParsing = false,
  ) {}
  private path(file: EditableConfigFile) {
    return file === 'accounts'
      ? this.runtime.paths.accounts
      : file === 'banks'
        ? this.runtime.paths.banks
        : this.runtime.paths.parsing;
  }
  private enabled(file: EditableConfigFile) {
    return file === 'accounts'
      ? this.editable
      : file === 'banks'
        ? this.editableBanks
        : this.editableParsing;
  }
  private async checkPath(file: EditableConfigFile) {
    const path = resolve(this.path(file));
    const info = await lstat(path);
    if (!info.isFile() || (await realpath(path)) !== path)
      throw new Error('Configuration must be a regular file without symlinks');
    return info;
  }
  private async writable(file: EditableConfigFile) {
    if (!this.enabled(file)) return false;
    return access(dirname(this.path(file)), constants.W_OK).then(
      () => true,
      () => false,
    );
  }
  async read() {
    await this.checkPath('accounts');
    const files = await readConfigFiles(this.runtime.paths);
    const editableFiles = {
      accounts: await this.writable('accounts'),
      banks: await this.writable('banks'),
      parsing: await this.writable('parsing'),
    };
    return {
      ...files,
      revision: configRevision(files),
      activeRevision: this.runtime.status().activeRevision,
      editable: editableFiles.accounts,
      editableFiles,
    };
  }
  async previewFile(file: EditableConfigFile, content: string, expected: string) {
    return this.runtime.withConfiguration(async validate => {
      const current = await this.read();
      if (current.revision !== expected) throw new ConfigConflict();
      await validate({ ...current, [file]: content });
      return { valid: true, revision: expected };
    });
  }
  async preview(accounts: string, expected: string) {
    return this.previewFile('accounts', accounts, expected);
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
  async saveFile(file: EditableConfigFile, content: string, expected: string) {
    if (!this.enabled(file)) throw new Error('Configuration is read-only');
    const path = this.path(file);
    return this.runtime.withConfiguration(async validate => {
      const current = await this.read();
      if (!current.editableFiles[file]) throw new Error('Configuration directory is read-only');
      if (current.revision !== expected) throw new ConfigConflict();
      const candidate: ConfigFiles = { ...current, [file]: content };
      const snapshot = await validate(candidate);
      const info = await this.checkPath(file);
      if ((await this.read()).revision !== expected) throw new ConfigConflict();
      const temporary = `${path}.${randomUUID()}.tmp`;
      const backup = `${path}.previous`;
      const backupTemporary = `${backup}.${randomUUID()}.tmp`;
      let committed = false;
      try {
        const previous = await open(backupTemporary, 'wx', 0o600);
        try {
          await previous.writeFile(current[file]);
          await previous.sync();
        } finally {
          await previous.close();
        }
        // Publish only a complete backup. Linking is atomic and never replaces
        // an existing operator copy or follows an existing backup symlink.
        await link(backupTemporary, backup).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        });
        const fileHandle = await open(temporary, 'wx', info.mode & 0o777);
        try {
          const temporaryInfo = await fileHandle.stat();
          if (temporaryInfo.uid !== info.uid || temporaryInfo.gid !== info.gid)
            await fileHandle.chown(info.uid, info.gid);
          await fileHandle.chmod(info.mode & 0o777);
          await fileHandle.writeFile(content);
          await fileHandle.sync();
        } finally {
          await fileHandle.close();
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
        await unlink(backupTemporary).catch(() => {});
      }
    });
  }
  async save(accounts: string, expected: string) {
    return this.saveFile('accounts', accounts, expected);
  }
}
