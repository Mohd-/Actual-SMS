import type { ActualAdapter, ResolvedConfig } from './types.js';
import { WorkGate } from './work-gate.js';
import {
  ConfigurationError,
  configRevision,
  parseConfigFiles,
  readConfigFiles,
  resolveConfig,
  type ConfigFiles,
  type ConfigPaths,
} from './runtime-config.js';
import { reportActualCompatibility } from './actual-version.js';

/** Owns the configured Actual session and atomic activation of derived file snapshots. */
export class Runtime {
  readonly gate = new WorkGate(true);
  private connected = false;
  private stopping = false;
  private attempted = false;
  private revision: string | null = null;
  private error: string | null = null;
  constructor(
    readonly actual: ActualAdapter,
    readonly config: ResolvedConfig,
    readonly paths: ConfigPaths,
  ) {}
  status() {
    return {
      ready: this.connected && !this.gate.paused && !this.gate.busy && !this.stopping,
      connected: this.connected,
      changing: this.gate.busy,
      activeRevision: this.revision,
      error: this.error,
    };
  }
  async reconnect() {
    return this.gate.change(async () => {
      if (this.stopping) throw new Error('Runtime is shutting down');
      this.gate.paused = true;
      try {
        const files = await readConfigFiles(this.paths);
        parseConfigFiles(files);
        this.connected = false;
        if (this.attempted) await this.actual.shutdown();
        this.attempted = true;
        await this.actual.initialize();
        await reportActualCompatibility(this.actual);
        const snapshot = await resolveConfig(files, this.actual);
        if (configRevision(await readConfigFiles(this.paths)) !== configRevision(files))
          throw new ConfigurationError(
            'Configuration changed during connection; retry with the current files',
          );
        this.activate(files, snapshot);
        this.connected = true;
      } catch (error) {
        this.connected = false;
        if (this.attempted) await this.actual.shutdown().catch(() => {});
        this.error =
          'Actual connection or configuration validation failed; check the server and configured names.';
        if (error instanceof ConfigurationError) throw error;
        throw new Error(this.error);
      }
    });
  }
  activate(files: ConfigFiles, snapshot: ResolvedConfig) {
    if (this.stopping) throw new Error('Runtime is shutting down');
    Object.assign(this.config, snapshot);
    this.revision = configRevision(files);
    this.error = null;
    this.gate.paused = false;
  }
  async withConfiguration<T>(operation: () => Promise<T>): Promise<T> {
    return this.gate.change(async () => {
      if (!this.connected || this.stopping)
        throw new Error('Connect to Actual before editing configuration');
      return operation();
    });
  }
  hold(error: string) {
    this.gate.paused = true;
    this.error = error;
  }
  beginShutdown() {
    this.stopping = true;
    this.gate.paused = true;
  }
  async shutdown() {
    this.beginShutdown();
    while (this.gate.busy) await new Promise(resolve => setTimeout(resolve, 10));
    await this.gate.change(async () => {
      await this.actual.sync().catch(() => {});
      await this.actual.shutdown();
      this.connected = false;
    });
  }
}
