import { loadParserConfig } from './parsing/config.js';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadBankConfigFile, loadConfigFile, loadEnv } from './config.js';
import { EventStore } from './db.js';
import { ActualApiAdapter } from './actual.js';
import { reportActualCompatibility } from './actual-version.js';
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
const actual = new ActualApiAdapter({
  serverURL: env.ACTUAL_SERVER_URL,
  password: env.ACTUAL_PASSWORD,
  syncId: env.ACTUAL_SYNC_ID,
  encryptionPassword: env.ACTUAL_ENCRYPTION_PASSWORD,
  dataDir: env.ACTUAL_CACHE_DIR,
});
let ready = false;
try {
  await actual.initialize();
  await reportActualCompatibility(actual);
  const [accounts, categories] = await Promise.all([actual.accounts(), actual.categories()]);
  const config = resolveConfig(file, banks, parsing, accounts, categories);
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
  );
  await processor
    .refreshMappings()
    .catch(error =>
      console.warn('Initial merchant mapping refresh failed; using persisted mappings', error),
    );
  processor.start();
  ready = true;
  const app = buildServer({
    apiKey: env.API_KEY,
    banks,
    store,
    processor,
    ready: () => ready,
    logger: env.LOG_LEVEL,
  });
  const mappingRefresh = setInterval(
    () =>
      void processor
        .refreshMappings()
        .catch(error => app.log.warn({ error }, 'merchant mapping refresh failed')),
    env.MAPPING_REFRESH_MINUTES * 60_000,
  );
  mappingRefresh.unref();
  const shutdown = async (signal: string) => {
    ready = false;
    clearInterval(mappingRefresh);
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await processor.stop();
    await actual.sync().catch(() => {});
    await actual.shutdown();
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
