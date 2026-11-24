import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadActualApi } from '../src/actual-sdk.js';
import { ActualApiAdapter } from '../src/actual.js';
import { EventStore } from '../src/db.js';
import { Processor } from '../src/processor.js';
import { NoopEnricher } from '../src/enricher.js';
import { loadBankConfigFile } from '../src/config.js';
import { loadParserConfig } from '../src/parsing/config.js';
import { withDisposableBudget } from './disposable-budget.js';
import type { ResolvedConfig } from '../src/types.js';

async function main() {
  if (process.env.LIVE_ACTUAL_TEST !== '1' || process.env.ACTUAL_SMOKE_CREATE_BUDGET !== '1') {
    console.error(
      'Refusing disposable smoke test: set LIVE_ACTUAL_TEST=1 and ACTUAL_SMOKE_CREATE_BUDGET=1',
    );
    process.exitCode = 2;
    return;
  }

  const serverURL = process.env.ACTUAL_SERVER_URL;
  const password = process.env.ACTUAL_SMOKE_PASSWORD;
  if (!serverURL || !password)
    throw new Error('ACTUAL_SERVER_URL and ACTUAL_SMOKE_PASSWORD are required');
  const actual = await loadActualApi();
  let passed = false;
  await withDisposableBudget(
    actual,
    {
      serverURL,
      password,
      protectedSyncId: process.env.ACTUAL_SYNC_ID,
      onCleanupVerified: async () => {
        if (process.env.ACTUAL_SMOKE_REPORT_PATH)
          await writeFile(
            process.env.ACTUAL_SMOKE_REPORT_PATH,
            JSON.stringify(
              { phase: 'cleaned', disposableBudgetDeleted: true, productionBudgetLoaded: false },
              null,
              2,
            ) + '\n',
            { mode: 0o600 },
          );
      },
    },
    async context => {
      if (process.env.ACTUAL_SMOKE_REPORT_PATH)
        await writeFile(
          process.env.ACTUAL_SMOKE_REPORT_PATH,
          JSON.stringify(
            { phase: 'created', name: context.name, syncId: context.syncId },
            null,
            2,
          ) + '\n',
          { mode: 0o600 },
        );
      const checking = await actual.createAccount({
        name: 'SMS Smoke Checking',
        offbudget: false,
        closed: false,
      });
      const receiving = await actual.createAccount({
        name: 'SMS Smoke Receiving',
        offbudget: false,
        closed: false,
      });
      const group = await actual.createCategoryGroup({
        name: 'SMS Smoke Categories',
        is_income: false,
      });
      const fees = await actual.createCategory({
        name: 'SMS Smoke Fees',
        group_id: group,
        is_income: false,
      });
      await actual.sync();
      const reader = join(context.cacheDir, 'reader');
      await mkdir(reader, { mode: 0o700 });
      const smokeScript = fileURLToPath(new URL('./smoke-actual.js', import.meta.url));
      // A separate SDK process and cache force a real upload/download round trip.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [smokeScript], {
          stdio: 'inherit',
          env: {
            PATH: process.env.PATH,
            LIVE_ACTUAL_TEST: '1',
            ACTUAL_SERVER_URL: serverURL,
            ACTUAL_SMOKE_PASSWORD: password,
            ACTUAL_SMOKE_SYNC_ID: context.syncId,
            ACTUAL_SMOKE_CACHE_DIR: reader,
            ACTUAL_SMOKE_ACCOUNT_NAME: 'SMS Smoke Checking',
          },
        });
        child.once('error', reject);
        child.once('exit', code =>
          code === 0 ? resolve() : reject(new Error(`Fresh-client smoke test exited ${code}`)),
        );
      });
      await actual.sync();
      const adapter = new ActualApiAdapter({
        serverURL,
        password,
        syncId: context.syncId,
        dataDir: context.cacheDir,
      });
      // The lifecycle has already initialized this SDK and loaded only the new budget.
      const banks = await loadBankConfigFile(process.env.BANKS_CONFIG_PATH ?? 'config/banks.yaml');
      const parsing = await loadParserConfig(
        process.env.PARSING_CONFIG_PATH ?? 'config/parsing.yaml',
        banks,
      );
      const config: ResolvedConfig = {
        banks,
        parsing,
        accounts: [
          {
            key: checking,
            id: checking,
            name: 'SMS Smoke Checking',
            match: { bank: 'sab', accountSuffixes: ['1234'] },
          },
          {
            key: receiving,
            id: receiving,
            name: 'SMS Smoke Receiving',
            match: { bank: 'alrajhi', accountSuffixes: ['5678'] },
          },
        ],
        bankFeesCategoryId: fees,
        eligibleCategories: [],
      };
      const store = new EventStore(':memory:');
      try {
        const processor = new Processor(store, adapter, new NoopEnricher(), config);
        const receivedAt = '2026-08-22T00:31:00+03:00';
        const purchase = 'Purchase Card **1234 Amount SAR 25 at FOOTPRINT on 2026-08-22 00:30';
        store.enqueue({ eventId: 'purchase-one', sender: 'SAB', message: purchase, receivedAt });
        store.enqueue({ eventId: 'purchase-two', sender: 'SAB', message: purchase, receivedAt });
        store.enqueue({
          eventId: 'debit',
          sender: 'SAB',
          message:
            'Outgoing transfer From: 1234 To: 5678 Amount SAR 100 Fees SAR 1 on 2026-08-22 10:05',
          receivedAt,
        });
        store.enqueue({
          eventId: 'credit',
          sender: 'AlRajhiBank',
          message: 'Incoming transfer From: 1234 To: 5678 Amount SAR 100 on 2026-08-22 10:05',
          receivedAt,
        });
        for (let i = 0; i < 4; i++) await processor.tick();
        for (const id of ['purchase-one', 'purchase-two', 'debit', 'credit'])
          assert.equal(store.get(id)?.status, 'imported', `Synthetic event ${id} did not import`);
        const transactions = await actual.getTransactions(checking, '2026-08-22', '2026-08-22');
        const purchases = transactions.filter(tx => tx.amount === -2500);
        assert.equal(purchases.length, 2, 'Equal purchases must remain distinct in real Actual');
        assert.equal(new Set(purchases.map(tx => tx.imported_id)).size, 2);
        assert.equal(transactions.filter(tx => tx.amount === -10000 && tx.transfer_id).length, 1);
        assert.equal(
          transactions.filter(tx => tx.amount === -100 && tx.category === fees).length,
          1,
        );
        const credits = await actual.getTransactions(receiving, '2026-08-22', '2026-08-22');
        assert.equal(credits.filter(tx => tx.amount === 10000 && tx.transfer_id).length, 1);
        assert.equal(await actual.getAccountBalance(checking), -15100);
        assert.equal(await actual.getAccountBalance(receiving), 10000);
        // Retry uses the persisted ID and must leave the real ledger unchanged.
        store.update('purchase-two', 'queued', { nextAttemptAt: new Date(0).toISOString() });
        await new Processor(store, adapter, new NoopEnricher(), config).tick();
        assert.equal(
          (await actual.getTransactions(checking, '2026-08-22', '2026-08-22')).length,
          transactions.length,
        );
        const rulePayee = await actual.createPayee({ name: 'Rule-selected Payee' });
        await actual.createRule({
          stage: 'pre',
          conditionsOp: 'and',
          conditions: [{ op: 'is', field: 'imported_payee', value: 'RULETARGET' }],
          actions: [
            { op: 'set', field: 'payee', value: rulePayee },
            { op: 'set', field: 'category', value: fees },
          ],
        });
        const enqueuePurchase = (eventId: string, amount: number, merchant: string) =>
          store.enqueue({
            eventId,
            sender: 'SAB',
            receivedAt,
            message: `Purchase Card **1234 Amount SAR ${amount} at ${merchant} on 2026-08-22 00:30`,
          });
        enqueuePurchase('rule-control', 71, 'RULETARGET');
        await processor.tick();

        const enqueuePending = (eventId: string, amount: number, merchant: string) => {
          store.merchantAssignments.suggest(
            checking,
            merchant.toLowerCase(),
            {
              payee: 'Proposed Name',
              categoryId: fees,
              confidence: 0.8,
              reason: 'Smoke test',
            },
            eventId,
          );
          enqueuePurchase(eventId, amount, merchant);
        };
        enqueuePending('pending-rule', 72, 'RULETARGET');
        enqueuePending('pending-no-rule', 73, 'NORULE');
        const importTransactions = adapter.importTransactions.bind(adapter);
        adapter.importTransactions = async (accountId, rows) => {
          const result = await importTransactions(accountId, rows);
          adapter.importTransactions = importTransactions;
          throw new Error(
            `Simulated lost import response after writing ${result.added.length} transaction`,
          );
        };
        await processor.tick();
        assert.equal(store.get('pending-rule')?.status, 'queued');
        // Sync the first write before retrying to verify there is no miscategorized interim write.
        await actual.sync();
        const pendingRows = () => actual.getTransactions(checking, '2026-08-22', '2026-08-22');
        const first = (await pendingRows()).filter(tx => tx.amount === -7200);
        assert.equal(first.length, 1);
        assert.equal(first[0]?.category, null);
        assert.equal(
          (await actual.getPayees()).find(payee => payee.id === first[0]?.payee)?.name,
          'RULETARGET',
        );
        store.update('pending-rule', 'queued', { nextAttemptAt: new Date(0).toISOString() });
        const restarted = new Processor(store, adapter, new NoopEnricher(), config);
        await restarted.tick();
        await restarted.tick();
        assert.equal(store.get('pending-rule')?.status, 'imported');
        assert.equal(store.get('pending-no-rule')?.status, 'imported');

        const finalRows = await pendingRows();
        const control = finalRows.find(tx => tx.amount === -7100);
        assert.equal(control?.category, fees);
        assert.equal(control?.payee, rulePayee);
        assert.equal(finalRows.filter(tx => tx.amount === -7200).length, 1);
        assert.equal(finalRows.find(tx => tx.amount === -7200)?.id, first[0]?.id);
        const unrelated = finalRows.find(tx => tx.amount === -7300);
        assert.equal(unrelated?.category, null);
        assert.equal(
          (await actual.getPayees()).find(payee => payee.id === unrelated?.payee)?.name,
          'NORULE',
        );
        passed = true;
      } finally {
        store.close();
      }
    },
  );
  if (passed) {
    if (process.env.ACTUAL_SMOKE_REPORT_PATH)
      await writeFile(
        process.env.ACTUAL_SMOKE_REPORT_PATH,
        JSON.stringify(
          {
            passed: true,
            disposableBudgetDeleted: true,
            productionBudgetLoaded: false,
            checks: [
              'fresh-client-download-import-sync-delete',
              'merchant-classification',
              'Riyadh-date',
              'distinct-equal-purchases',
              'linked-transfer',
              'bank-fee',
              'retry-idempotency',
              'pending-merchant-assignment-bypasses-actual-rules',
              'existing-budget-catalog-preserved',
            ],
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
    console.log(
      'Disposable Actual smoke passed; temporary budget deleted and existing budget catalog preserved.',
    );
  }
}

function reportFailure(error: unknown) {
  const details =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)
      : { message: String(error) };
  const safe = Object.fromEntries(
    ['name', 'type', 'reason', 'message', 'code', 'status']
      .filter(key => details[key] !== undefined)
      .map(key => [
        key,
        String(details[key]).replaceAll(
          process.env.ACTUAL_SMOKE_PASSWORD ?? '\u0000',
          '[redacted]',
        ),
      ]),
  );
  console.error('Disposable smoke failed:', JSON.stringify(safe));
  process.exitCode = 1;
}

// Some pinned SDK handlers also reject a detached promise for handled API errors.
// Keep the process alive long enough for ownership-checked cleanup to finish.
if (process.env.LIVE_ACTUAL_TEST === '1' && process.env.ACTUAL_SMOKE_CREATE_BUDGET === '1')
  process.on('unhandledRejection', reportFailure);
await main().catch(reportFailure);
