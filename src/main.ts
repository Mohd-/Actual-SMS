import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadEnv } from './config.js';
import { EventStore } from './db.js';
import { ActualApiAdapter } from './actual.js';
import { NoopEnricher, OpenCodeGoEnricher } from './enricher.js';
import { Processor } from './processor.js';
import { buildServer } from './server.js';
import { Runtime } from './runtime.js';
import { ConfigurationError, parseConfigFiles, readConfigFiles } from './runtime-config.js';
import { ConfigEditor } from './config-editor.js';
import { ManagementCredentials } from './management/credentials.js';
import type { ResolvedConfig } from './types.js';

const env = loadEnv();
await Promise.all([
  mkdir(dirname(env.DB_PATH), { recursive: true }),
  mkdir(env.ACTUAL_CACHE_DIR, { recursive: true }),
]);
const paths = {
  accounts: env.CONFIG_PATH,
  banks: env.BANKS_CONFIG_PATH,
  parsing: env.PARSING_CONFIG_PATH,
};
// File/schema errors remain fatal, even when management is enabled.
const parsed = parseConfigFiles(await readConfigFiles(paths));
const config: ResolvedConfig = {
  banks: parsed.banks,
  parsing: parsed.parsing,
  accounts: [],
  bankFeesCategoryId: '',
  eligibleCategories: [],
};
const store = new EventStore(env.DB_PATH);
const maintenanceFile = join(dirname(env.DB_PATH), 'actual-sms-maintenance');
let maintenancePaused = existsSync(maintenanceFile);
const actual = new ActualApiAdapter({
  serverURL: env.ACTUAL_SERVER_URL,
  password: env.ACTUAL_PASSWORD,
  syncId: env.ACTUAL_SYNC_ID,
  encryptionPassword: env.ACTUAL_ENCRYPTION_PASSWORD,
  dataDir: env.ACTUAL_CACHE_DIR,
});
const runtime = new Runtime(actual, config, paths);
if (maintenancePaused) runtime.beginShutdown();
try {
  if (!maintenancePaused)
    await runtime.reconnect().catch(error => {
      if (!env.MANAGEMENT_ENABLED || error instanceof ConfigurationError) throw error;
      console.warn(
        'Actual unavailable; imports paused. Use management to retry the configured connection.',
      );
    });
  const ai = env.OPENCODE_GO_API_KEY
    ? new OpenCodeGoEnricher(env.OPENCODE_GO_API_KEY, env.OPENCODE_GO_MODEL)
    : new NoopEnricher();
  const processor = new Processor(
    store,
    actual,
    ai,
    config,
    env.MAX_ATTEMPTS,
    env.ENRICHMENT_MIN_CONFIDENCE,
    undefined,
    runtime.gate,
  );
  await processor
    .refreshMappings()
    .catch(() => console.warn('Initial mapping refresh failed; using persisted mappings'));
  const credentials = new ManagementCredentials(store.db);
  const app = buildServer({
    apiKey: env.API_KEY,
    banks: () => config.banks,
    store,
    processor,
    ready: () => runtime.status().ready,
    logger: env.LOG_LEVEL,
    taskerCredentials: credentials,
    maintenance: {
      paused: () => maintenancePaused,
      pause: async () => {
        await writeFile(maintenanceFile, 'paused by coordinated updater\n', { mode: 0o600 });
        maintenancePaused = true;
        runtime.beginShutdown();
        clearInterval(timer);
        await processor.stop();
        await runtime.shutdown();
      },
    },
    management: env.MANAGEMENT_ENABLED
      ? {
          runtime,
          editor: new ConfigEditor(runtime, env.MANAGEMENT_EDIT_ACCOUNTS),
          credentials,
          origin: env.MANAGEMENT_URL!,
          passwordHash: env.MANAGEMENT_PASSWORD_HASH!,
          secret: env.MANAGEMENT_SECRET!,
          refresh: () =>
            processor
              .refreshMappings()
              .catch(() => app.log.warn('Mapping refresh failed; using persisted mappings')),
        }
      : undefined,
  });
  const timer = setInterval(
    () =>
      void processor
        .refreshMappings()
        .catch(() => app.log.warn('Mapping refresh failed; using persisted mappings')),
    env.MAPPING_REFRESH_MINUTES * 60000,
  );
  timer.unref();
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    runtime.beginShutdown();
    clearInterval(timer);
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await processor.stop();
    await runtime.shutdown();
    store.close();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  await app.listen({ host: '0.0.0.0', port: env.PORT });
  if (!maintenancePaused) processor.start();
} catch (error) {
  await runtime.shutdown().catch(() => {});
  store.close();
  throw error;
}
