import { loadParserConfig } from './parsing/config.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadBankConfigFile, loadConfigFile, loadEnv } from './config.js';
import { EventStore } from './db.js';
import { ActualApiAdapter } from './actual.js';
import { NoopEnricher, OpenCodeGoEnricher } from './enricher.js';
import { Processor } from './processor.js';
import { buildServer } from './server.js';
import { resolveConfig } from './resolve-config.js';

const env = loadEnv();
await Promise.all([
  mkdir(dirname(env.DB_PATH), { recursive: true }),
  mkdir(env.ACTUAL_CACHE_DIR, { recursive: true }),
]);
const banks = await loadBankConfigFile(env.BANKS_CONFIG_PATH);
const parsing = await loadParserConfig(env.PARSING_CONFIG_PATH, banks);
const file = await loadConfigFile(env.CONFIG_PATH, banks);
const store = new EventStore(env.DB_PATH);
const maintenanceFile = join(dirname(env.DB_PATH), 'actual-sms-maintenance');
let paused = existsSync(maintenanceFile);
let ready = false;
let initialized = false;
let processor: Processor | undefined;
let mappingRefresh: NodeJS.Timeout | undefined;
const actual = new ActualApiAdapter({
  serverURL: env.ACTUAL_SERVER_URL,
  password: env.ACTUAL_PASSWORD,
  syncId: env.ACTUAL_SYNC_ID,
  encryptionPassword: env.ACTUAL_ENCRYPTION_PASSWORD,
  dataDir: env.ACTUAL_CACHE_DIR,
});
try {
  if (!paused) {
    await actual.initialize();
    initialized = true;
    const [accounts, categories] = await Promise.all([actual.accounts(), actual.categories()]);
    const config = resolveConfig(file, banks, parsing, accounts, categories);
    const ai = env.OPENCODE_GO_API_KEY
      ? new OpenCodeGoEnricher(env.OPENCODE_GO_API_KEY, env.OPENCODE_GO_MODEL)
      : new NoopEnricher();
    processor = new Processor(
      store,
      actual,
      ai,
      config,
      env.MAX_ATTEMPTS,
      env.ENRICHMENT_MIN_CONFIDENCE,
    );
    await processor
      .refreshMappings()
      .catch(() =>
        console.warn('Initial merchant mapping refresh failed; using persisted mappings'),
      );
    processor.start();
    ready = true;
  }
  const app = buildServer({
    apiKey: env.API_KEY,
    banks,
    store,
    processor: {
      tick: async () => {
        if (!paused) await processor?.tick();
      },
    },
    ready: () => ready,
    logger: env.LOG_LEVEL,
    maintenance: {
      paused: () => paused,
      pause: async () => {
        await writeFile(maintenanceFile, 'paused by coordinated updater\n', { mode: 0o600 });
        paused = true;
        ready = false;
        if (mappingRefresh) clearInterval(mappingRefresh);
        await processor?.stop();
        if (initialized) {
          await actual.sync().catch(() => {});
          await actual.shutdown();
          initialized = false;
        }
      },
    },
  });
  if (processor) {
    mappingRefresh = setInterval(() => {
      if (!paused)
        void processor!
          .refreshMappings()
          .catch(() => app.log.warn('merchant mapping refresh failed'));
    }, env.MAPPING_REFRESH_MINUTES * 60_000);
    mappingRefresh.unref();
  }
  const shutdown = async (signal: string) => {
    ready = false;
    if (mappingRefresh) clearInterval(mappingRefresh);
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await processor?.stop();
    if (initialized) {
      await actual.sync().catch(() => {});
      await actual.shutdown();
    }
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  await app.listen({ host: '0.0.0.0', port: env.PORT });
} catch (error) {
  ready = false;
  await actual.shutdown().catch(() => {});
  store.close();
  throw error;
}
