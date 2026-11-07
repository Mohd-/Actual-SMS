/** Isolated browser verification: temporary YAML, in-memory SQLite, fake Actual. */
import { chromium, expect } from '@playwright/test';
import { hash } from 'bcryptjs';
import { readFile } from 'node:fs/promises';
import { runtimeFixture } from '../test/fixtures/runtime.js';
import { EventStore } from '../src/db.js';
import { ConfigEditor } from '../src/config-editor.js';
import { ManagementCredentials } from '../src/management/credentials.js';
import { buildServer } from '../src/server.js';
import type { Processor } from '../src/processor.js';

const f = await runtimeFixture();
const store = new EventStore(':memory:');
const credentials = new ManagementCredentials(store.db);
const origin = 'http://127.0.0.1:43123';
const options = {
  runtime: f.runtime,
  editor: new ConfigEditor(f.runtime, true),
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
  await app.listen({ host: '127.0.0.1', port: 43123 });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ timezoneId: 'Asia/Riyadh' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => void dialog.accept());
  await page.goto(origin + '/manage');
  await page.getByLabel('Management password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#status-data')).toContainText('"ready": true');
  await page.getByRole('button', { name: 'SMS audit', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(id) }).click();
  await expect(page.locator('#event-detail')).toContainText(
    '<script>globalThis.injected=true</script>',
  );
  expect(await page.evaluate(() => Object.hasOwn(globalThis, 'injected'))).toBe(false);
  await page.getByRole('button', { name: 'Configuration', exact: true }).click();
  const accounts = page.getByLabel('Account routing YAML');
  await expect(accounts).toHaveValue(/1234/);
  await accounts.fill(
    (await accounts.inputValue()).replace('1234', '4321') + '# Browser-preserved comment\n',
  );
  await page.getByRole('button', { name: 'Validate and preview changes', exact: true }).click();
  await expect(page.locator('#after')).toContainText('4321');
  await page.getByLabel('I reviewed the changes').check();
  await page.getByRole('button', { name: 'Save and activate YAML', exact: true }).click();
  await expect(page.locator('#diff')).toBeHidden();
  expect(await readFile(f.paths.accounts, 'utf8')).toContain('# Browser-preserved comment');
  expect(f.config.accounts[0]?.match.accountSuffixes).toEqual(['4321']);
  // Read-only deployment behavior uses the same application, without another config store.
  options.editor = new ConfigEditor(f.runtime, false);
  await page.getByRole('button', { name: 'Reload files from disk', exact: true }).click();
  await expect(accounts).toHaveAttribute('readonly', '');
  await expect(
    page.getByRole('button', { name: 'Validate and preview changes', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Tasker', exact: true }).click();
  await expect(page.locator('#checkpoint-state')).toContainText('Not initialized');
  expect(store.inboxCheckpoint()).toBeUndefined();
  await page
    .getByRole('button', { name: 'Generate / replace restricted key', exact: true })
    .click();
  await expect(page.getByLabel('Restricted key', { exact: true })).not.toHaveValue('');
  await page.getByLabel('Public HTTPS service origin').fill('https://sms.example.test');
  const downloading = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download configured Tasker project', exact: true })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Actual_SMS_Inbox.prj.xml');
  expect(store.inboxCheckpoint()).toBeUndefined();
  await page.getByLabel('Start at device-local time').fill('2026-01-01T09:30:00');
  await page.getByRole('button', { name: 'Confirm checkpoint change', exact: true }).click();
  await expect(page.locator('#checkpoint-state')).toContainText('2026-01-01T06:30:00.000Z');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    'Management browser smoke passed: login, safe audit, YAML preview/save/read-only mode, Tasker export, checkpoint/time zone, mobile layout, logout.',
  );
} finally {
  await browser?.close();
  await app.close();
  store.close();
  await f.cleanup();
}
