/** Isolated browser verification: temporary YAML, in-memory SQLite, fake Actual. */
import { chromium, expect } from '@playwright/test';
import { hash } from 'bcryptjs';
import { readFile } from 'node:fs/promises';
import { runtimeFixture } from '../test/fixtures/runtime.js';
import { EventStore } from '../src/db.js';
import { ConfigEditor } from '../src/config-editor.js';
import { ManagementCredentials } from '../src/management/credentials.js';
import { PayeeSuggestions } from '../src/enricher.js';
import { buildServer } from '../src/server.js';
import type { Processor } from '../src/processor.js';

const f = await runtimeFixture();
const store = new EventStore(':memory:');
const credentials = new ManagementCredentials(store.db);
const origin = 'http://127.0.0.1:43123';
const options = {
  runtime: f.runtime,
  suggestions: new PayeeSuggestions(
    {
      enrich: async () => ({
        status: 'success',
        suggestion: { categoryId: 'food', confidence: 0.91, reason: 'Coffee shop' },
        model: 'fake',
        durationMs: 0,
        httpStatus: 200,
        response: {},
      }),
    },
    0.7,
  ),
  editor: new ConfigEditor(f.runtime, true, true, true),
  credentials,
  origin,
  passwordHash: await hash('browser-test-password', 4),
  secret: 'ab'.repeat(32),
};
const app = buildServer({
  apiKey: 'legacy-smoke-key',
  banks: () => f.config.banks,
  store,
  processor: { tick: async () => {} } as Processor,
  ready: () => f.runtime.status().ready,
  management: options,
});
let browser;
try {
  const { id } = store.enqueue({
    sender: 'SAB',
    message: '<script>globalThis.injected=true</script>',
    receivedAt: '2026-08-22T10:00:00Z',
  });
  const { id: arabicId } = store.enqueue({
    sender: 'SAB',
    message: 'شراء\nالمبلغ: 12.00 SAR\nبطاقة: ***1234\nفي: 2026-08-22 10:10:30',
    receivedAt: '2026-08-22T10:10:30Z',
  });
  await app.listen({ host: '127.0.0.1', port: 43123 });
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ timezoneId: 'Asia/Riyadh' });
  page.setDefaultTimeout(12_000);
  const errors: string[] = [];
  const externalRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== origin) externalRequests.push(request.url());
  });
  page.on('dialog', dialog => void dialog.accept());

  const sheet = () => page.locator('dialog.sheet').last();
  const closeSheet = async () => {
    await sheet().getByRole('button', { name: 'Close' }).click();
  };
  const nav = async (name: string) => {
    await page.getByRole('link', { name, exact: true }).click();
  };
  const confirm = async (name: string) => {
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
  };

  await page.goto(origin + '/manage');
  await page.getByLabel('Management password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Imports are running')).toBeVisible();

  await nav('SMS audit');
  await expect(page.getByRole('heading', { name: 'SMS audit' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('<script>globalThis.injected=true</script>');
  await page.getByRole('button', { name: `Open event ${id}` }).click();
  await expect(sheet()).toContainText('<script>globalThis.injected=true</script>');
  await expect(sheet()).toContainText('Original input');
  expect(await page.evaluate(() => Object.hasOwn(globalThis, 'injected'))).toBe(false);
  await closeSheet();

  await page.getByRole('button', { name: `Open event ${arabicId}` }).click();
  await expect(sheet().locator('[dir="rtl"]').first()).toBeVisible();
  await closeSheet();

  f.config.eligibleCategories = [{ id: 'food', name: 'Food' }];
  store.db.exec(`
    CREATE TABLE merchant_assignment_reviews (accountId TEXT, merchant TEXT, payee TEXT, categoryId TEXT, status TEXT, sourceRef TEXT);
    INSERT INTO merchant_assignment_reviews VALUES ('checking','split descriptor','Cafe Central','food','approved',NULL);
    INSERT INTO merchant_assignment_reviews VALUES ('credit','split descriptor','Another Cafe','other','approved',NULL);
  `);
  store.payees.refresh({
    payees: [
      { id: 'cafe', name: 'Cafe Central' },
      { id: 'other-cafe', name: 'Another Cafe' },
      { id: 'arabic', name: 'متجر-الرياض' },
    ],
    categories: [...f.config.eligibleCategories, { id: 'other', name: 'Other' }],
    tags: [{ id: 'work', name: 'work' }],
  });
  const mainCafe = store.payees.list('cafe central', 0, 1)[0]!;
  store.payees.save(mainCafe.id, mainCafe.revision, null, []);
  store.payees.defaults('Example Cafe');

  await nav('Payees');
  await expect(page.getByRole('heading', { name: 'Payees' })).toBeVisible();
  await page.getByLabel('Search payees').fill('Example Cafe');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Example Cafe', exact: true }).click();
  await expect(sheet()).toContainText('Example Cafe');
  await sheet().getByRole('button', { name: 'Suggest category' }).click();
  await expect(sheet()).toContainText('Food · 91%');
  await sheet().getByRole('button', { name: 'Use suggestion' }).click();
  await sheet().getByRole('button', { name: 'Save defaults' }).click();
  await expect(page.getByLabel('Category for Example Cafe')).toHaveValue('food');

  await page.getByRole('button', { name: 'Example Cafe', exact: true }).click();
  await sheet().getByLabel('#work').check();
  await sheet().getByRole('button', { name: 'Save defaults' }).click();
  await expect(page.locator('tr', { hasText: 'Example Cafe' })).toContainText('#work');

  await page.getByLabel('Search payees').fill('');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Example Cafe', exact: true }).click();
  await sheet().getByRole('button', { name: 'Link' }).first().click();
  const linkSheet = page.locator('dialog.sheet').last();
  await linkSheet.getByLabel('Target payee').fill('Cafe Central');
  await linkSheet.getByRole('option', { name: 'Cafe Central' }).click();
  await linkSheet.getByRole('button', { name: 'Link descriptor' }).click();
  await expect(page.locator('tr', { hasText: 'Cafe Central' })).toContainText('#work');

  await page.getByRole('button', { name: 'Cafe Central', exact: true }).click();
  await sheet().getByRole('button', { name: 'Use as separate payee' }).first().click();
  await confirm('Separate descriptor');
  await expect(page.getByLabel('Category for Example Cafe')).toHaveValue('');

  await page.getByLabel('Search payees').fill('split descriptor');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'split descriptor', exact: true }).click();
  await expect(sheet()).toContainText('Another Cafe');
  await expect(sheet()).toContainText('Cafe Central');
  await sheet().getByLabel('#work').check();
  await sheet().getByRole('button', { name: 'Save defaults' }).click();
  await page.getByRole('button', { name: 'split descriptor', exact: true }).click();
  await sheet().getByLabel('Actual category').click();
  await page.getByRole('option', { name: 'Leave uncategorized' }).click();
  await sheet().getByRole('button', { name: 'Save defaults' }).click();
  await expect(page.locator('tr', { hasText: 'split descriptor' })).not.toContainText(
    'Migration conflict',
  );

  await page.getByLabel('Search payees').fill('متجر');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('button', { name: 'متجر-الرياض', exact: true })).toBeVisible();

  await nav('Routing');
  await expect(page.getByRole('heading', { name: 'Routing' })).toBeVisible();
  const initialAccounts = await readFile(f.paths.accounts, 'utf8');
  const suffix = page.getByLabel('Account suffixes').first();
  await page.getByRole('button', { name: 'Remove 1234' }).click();
  await suffix.fill('4321');
  await suffix.press('Enter');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await confirm('Save and activate');
  await expect(page.getByText('Routing configuration saved and activated')).toBeVisible();
  expect(await readFile(f.paths.accounts, 'utf8')).toContain('4321');
  expect(await readFile(f.paths.accounts, 'utf8')).toContain('# Keep this comment');
  expect(f.config.accounts[0]?.match.accountSuffixes).toEqual(['4321']);

  await nav('Banks');
  await expect(page.getByRole('heading', { name: 'Banks' })).toBeVisible();
  await page.getByLabel('Bank name').first().fill('SAB Bank');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await confirm('Save and activate');
  await expect(page.getByText('Bank configuration saved and activated')).toBeVisible();
  expect(await readFile(f.paths.banks, 'utf8')).toContain('SAB Bank');

  await nav('Recognition');
  await expect(page.getByRole('heading', { name: 'Recognition' })).toBeVisible();
  const ignoredCard = page.locator('.card', { hasText: 'Ignored messages' });
  await ignoredCard.getByRole('button', { name: 'Add rule' }).click();
  await page.getByLabel('ignored pattern source 1').last().fill('zzz-never-match');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await confirm('Save and activate');
  await expect(page.getByText('Recognition configuration saved and activated')).toBeVisible();
  expect(await readFile(f.paths.parsing, 'utf8')).toContain('zzz-never-match');
  await page.getByLabel('Sender').fill('SAB');
  await page
    .getByLabel('Sample SMS')
    .fill('Purchase at Example Cafe\nAmount: SAR 12.00\nCard: *1234');
  await page.getByRole('button', { name: 'Test message' }).click();
  await expect(page.getByText('Recognized as a transaction')).toBeVisible();

  await nav('Phone setup');
  await expect(page.getByRole('heading', { name: 'Phone setup' })).toBeVisible();
  await expect(page.getByText('Not initialized', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Generate / replace key' }).click();
  await confirm('Replace key');
  const secretDialog = page.getByRole('dialog');
  await expect(secretDialog.getByLabel('Restricted key')).not.toHaveValue('');
  await secretDialog.getByRole('button', { name: 'I have saved the key' }).click();
  await page.getByLabel('Public HTTPS service origin').fill('https://sms.example.test');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download configured project' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Actual_SMS_Inbox.prj.xml');
  expect(store.inboxCheckpoint()).toBeUndefined();
  await page.getByRole('button', { name: 'Choose a starting point' }).click();
  await page.getByLabel('Start at device-local time').fill('2026-01-01T09:30:00');
  await page.getByRole('button', { name: 'Confirm checkpoint change' }).click();
  await expect(page.getByText('2026-01-01T06:30:00.000Z')).toBeVisible();
  expect(store.inboxCheckpoint()).toEqual({ date: 1767249000000, rowId: 0 });

  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of [
    '#/status',
    '#/events',
    '#/payees',
    '#/config/accounts',
    '#/config/banks',
    '#/config/parsing',
    '#/tasker',
  ]) {
    await page.evaluate(value => {
      location.hash = value;
    }, route);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('navigation', { name: 'Mobile management sections' })).toBeVisible();
  await page.getByRole('button', { name: 'Close navigation' }).click();
  await page.setViewportSize({ width: 320, height: 568 });
  for (const route of ['#/payees', '#/config/accounts', '#/events']) {
    await page.evaluate(value => {
      location.hash = value;
    }, route);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  options.editor = new ConfigEditor(f.runtime, false);
  await nav('Routing');
  await expect(page.getByText('Account editing is disabled', { exact: false })).toBeVisible();
  await nav('Overview');
  await page.getByRole('button', { name: 'Sign out', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(initialAccounts).toContain('# Keep this comment');
  console.log(
    'Management browser smoke passed: overview, private audit/detail, RTL message, payee inline/defaults/linking/conflicts, structured routing and bank saves, grammar save/tester, read-only fallback, guided Tasker export/checkpoint, mobile layouts, logout.',
  );
} finally {
  await browser?.close();
  await app.close();
  store.close();
  await f.cleanup();
}
