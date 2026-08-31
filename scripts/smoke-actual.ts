import { randomUUID } from 'node:crypto';
import { loadActualApi } from '../src/actual-sdk.js';

if (process.env.LIVE_ACTUAL_TEST !== '1') {
  console.error('Refusing live Actual smoke test: set LIVE_ACTUAL_TEST=1 for a disposable budget');
  process.exitCode = 2;
} else {
  const actual = await loadActualApi();
  const required = [
    'ACTUAL_SERVER_URL',
    'ACTUAL_SMOKE_SYNC_ID',
    'ACTUAL_SMOKE_PASSWORD',
    'ACTUAL_SMOKE_CACHE_DIR',
    'ACTUAL_SMOKE_ACCOUNT_NAME',
  ] as const;
  const missing = required.filter(name => !process.env[name]);
  if (missing.length) throw new Error(`Missing smoke-test variables: ${missing.join(', ')}`);

  const identifier = `actual-sms-smoke-${randomUUID()}`;
  const today = new Date().toISOString().slice(0, 10);
  let transactionId: string | undefined;
  let accountId: string | undefined;
  let importAttempted = false;
  let cleanupFailed = false;

  try {
    await actual.init({
      serverURL: process.env.ACTUAL_SERVER_URL!,
      password: process.env.ACTUAL_SMOKE_PASSWORD!,
      dataDir: process.env.ACTUAL_SMOKE_CACHE_DIR!,
    });
    await actual.downloadBudget(process.env.ACTUAL_SMOKE_SYNC_ID!, {
      password: process.env.ACTUAL_SMOKE_ENCRYPTION_PASSWORD,
    });

    const versionResult = await actual.getServerVersion();
    if (!('version' in versionResult)) throw new Error(`Version discovery: ${versionResult.error}`);
    const [accounts, categories] = await Promise.all([
      actual.getAccounts(),
      actual.getCategories(),
    ]);
    const matches = accounts.filter(
      account => !account.closed && account.name === process.env.ACTUAL_SMOKE_ACCOUNT_NAME,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Disposable account name must resolve exactly once (found ${matches.length})`,
      );
    }
    if (categories.length === 0) throw new Error('Disposable budget has no categories');

    accountId = matches[0]!.id;
    importAttempted = true;
    await actual.importTransactions(
      accountId,
      [
        {
          account: accountId,
          date: today,
          amount: 0,
          payee_name: identifier,
          notes: identifier,
          imported_id: identifier,
        },
      ],
      { defaultCleared: true },
    );
    await actual.sync();
    const imported = (await actual.getTransactions(matches[0]!.id, today, today)).filter(
      transaction => transaction.imported_id === identifier,
    );
    if (imported.length !== 1)
      throw new Error(`Expected one imported smoke transaction, found ${imported.length}`);
    transactionId = imported[0]!.id;
    console.log(`Actual ${versionResult.version} smoke transaction observed: ${identifier}`);
  } finally {
    if (importAttempted && accountId && !transactionId) {
      try {
        transactionId = (await actual.getTransactions(accountId, today, today)).find(
          transaction => transaction.imported_id === identifier,
        )?.id;
        if (!transactionId) cleanupFailed = true;
      } catch {
        cleanupFailed = true;
      }
    }
    if (transactionId) {
      try {
        await actual.deleteTransaction(transactionId);
        await actual.sync();
      } catch (error) {
        cleanupFailed = true;
        console.error(`SMOKE CLEANUP FAILED for ${identifier}`, error);
      }
    }
    await actual.shutdown().catch(error => console.error('Actual shutdown failed', error));
    if (cleanupFailed) {
      console.error(`SMOKE CLEANUP FAILED; manually remove transaction ${identifier}`);
      process.exitCode = 1;
    }
  }
}
