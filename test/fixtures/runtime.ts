import { mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../../src/runtime.js';
import type { ActualAdapter, ResolvedConfig } from '../../src/types.js';
import { banks, parsing } from './banks.js';

export async function runtimeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'actual-sms-runtime-'));
  const paths = {
    accounts: join(directory, 'accounts.yaml'),
    banks: join(directory, 'banks.yaml'),
    parsing: join(directory, 'parsing.yaml'),
  };
  await writeFile(
    paths.accounts,
    '# Keep this comment\naccounts:\n  - actualName: Checking\n    match:\n      bank: sab\n      accountSuffixes: ["1234"]\nbankFeesCategory: Fees\n',
  );
  await copyFile('config/banks.yaml', paths.banks);
  await copyFile('config/parsing.yaml', paths.parsing);
  const actual: ActualAdapter = {
    initialize: async () => {},
    shutdown: async () => {},
    sync: async () => {},
    serverVersion: async () => '26.11.0',
    accounts: async () => [{ id: 'checking', name: 'Checking' }],
    categories: async () => [{ id: 'fees', name: 'Fees' }],
    transactions: async () => [],
    transferPayee: async () => 'transfer',
    importTransactions: async () => ({ added: [], updated: [], errors: [] }),
  };
  const config: ResolvedConfig = {
    banks,
    parsing,
    accounts: [],
    bankFeesCategoryId: '',
    eligibleCategories: [],
  };
  const runtime = new Runtime(actual, config, paths);
  await runtime.reconnect();
  return {
    directory,
    paths,
    actual,
    config,
    runtime,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
