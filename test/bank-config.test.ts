import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { loadParserConfig } from '../src/parsing/config.js';
import { parsing } from './fixtures/banks.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadBankConfigFile, loadConfigFile, parseBankConfig } from '../src/config.js';
import { EventStore } from '../src/db.js';
import { Processor } from '../src/processor.js';
import { buildServer } from '../src/server.js';
import { parseSms } from '../src/parser.js';
import { resolveSmsSource } from '../src/sms-source.js';
import type { ActualAdapter, ResolvedConfig } from '../src/types.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const bank = {
  id: 'example-bank',
  name: 'Example Bank',
  senders: ['ExampleBank', 'Example Bank'],
  messageAliases: ['Example Bank'],
};

async function writeConfig(filename: string, content: string) {
  const directory = await mkdtemp(join(tmpdir(), 'sms-bank-config-'));
  directories.push(directory);
  const path = join(directory, filename);
  await writeFile(path, content);
  return path;
}

const accountYaml = (bankId = bank.id) => `accounts:
  - actualName: Example Checking
    match:
      bank: ${bankId}
      accountSuffixes: ['1234']
bankFeesCategory: Bank Fees
`;

describe('YAML bank registry', () => {
  it('imports a new bank from YAML through inbox filtering, parsing and account routing', async () => {
    const bankPath = await writeConfig(
      'banks.yaml',
      `banks:
  - id: example-bank
    name: Example Bank
    senders: [ExampleBank, Example Bank]
    messageAliases: [Example Bank]
    templates: [statement]
`,
    );
    const banks = await loadBankConfigFile(bankPath);
    const document = YAML.parse(
      await readFile(new URL('../config/parsing.yaml', import.meta.url), 'utf8'),
    );
    document.templates = [
      {
        id: 'statement',
        match: [{ source: 'Statement debit' }],
        kind: 'purchase',
        fields: { principal: [{ source: 'Amount SAR (?<value>[0-9.]+)' }] },
        required: ['principal'],
      },
    ];
    const parsing = await loadParserConfig(
      await writeConfig('parsing.yaml', YAML.stringify(document)),
      banks,
    );

    const file = await loadConfigFile(await writeConfig('accounts.yaml', accountYaml()), banks);
    const config: ResolvedConfig = {
      banks,
      parsing,
      accounts: file.accounts.map(account => ({
        key: 'example-account',
        id: 'example-account',
        name: account.actualName,
        match: account.match,
      })),
      bankFeesCategoryId: 'fees',
      eligibleCategories: [],
    };
    const importTransactions = vi.fn(async () => ({ added: ['tx-id'], updated: [], errors: [] }));
    const actual: ActualAdapter = {
      initialize: async () => {},
      shutdown: async () => {},
      sync: async () => {},
      serverVersion: async () => '26.5.2',
      accounts: async () => [],
      categories: async () => [],
      transactions: async () => [],
      transferPayee: async () => '',
      importTransactions,
    };
    const store = new EventStore(':memory:');
    const processor = new Processor(
      store,
      actual,
      {
        enrich: async () => ({ status: 'disabled', durationMs: 0 }),
      },
      config,
    );
    const app = buildServer({
      apiKey: 'secret',
      banks,
      store,
      processor: { tick: async () => {} } as Processor,
      ready: () => true,
    });
    try {
      const headers = { 'x-api-key': 'secret' };
      const start = await app.inject({ method: 'POST', url: '/v1/inbox-sync/start', headers });
      const checkpoint = start.json().checkpoint as { date: number; rowId: number };
      const message = 'Statement debit Card **1234 Amount SAR 25.00 at Example Store';
      const response = await app.inject({
        method: 'POST',
        url: '/v1/inbox-sync/batch',
        headers,
        payload: {
          checkpoint,
          rows: [{ rowId: 1, date: checkpoint.date + 1000, sender: '  EXAMPLE   bank  ', message }],
        },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json().results[0].outcome).toBe('queued');
      await processor.tick();
      expect(store.list({ limit: 10 })[0]?.status).toBe('imported');
      expect(importTransactions).toHaveBeenCalledWith('example-account', [
        expect.objectContaining({ amount: -2500, payee_name: 'Example Store' }),
      ]);
      expect(
        parseSms(message, new Date().toISOString(), banks, 'ExampleBank', parsing),
      ).toMatchObject({
        type: 'transaction',
        transaction: { bank: 'example-bank' },
      });
    } finally {
      await app.close();
      store.close();
    }
  });

  it('uses exact sender aliases and never falls back to a bank named in the body', () => {
    const banks = parseBankConfig({ banks: [bank] });
    expect(resolveSmsSource('ExampleBankPromo', 'Example Bank purchase', banks)).toEqual({
      type: 'unsupported',
      disposition: 'ignored',
    });
    expect(resolveSmsSource('', 'Example Bank purchase', banks)).toEqual({
      type: 'supported',
      bank: bank.id,
    });
    expect(resolveSmsSource('', 'NotExample Bank purchase', banks)).toEqual({
      type: 'unsupported',
      disposition: 'ignored',
    });
  });

  it('supports literal punctuation in aliases and retains ambiguous legacy sources for review', () => {
    const banks = parseBankConfig({
      banks: [
        { ...bank, messageAliases: ['Example+Bank'] },
        { id: 'other', name: 'Other', senders: ['Other'], messageAliases: ['Other'] },
      ],
    });
    expect(resolveSmsSource('', 'Example+Bank purchase', banks)).toEqual({
      type: 'supported',
      bank: bank.id,
    });
    expect(resolveSmsSource('', 'Example+Bank transfer to Other', banks)).toEqual({
      type: 'unsupported',
      disposition: 'needs_review',
    });
  });

  it('retains review-only senders without parsing them into transactions', () => {
    const banks = parseBankConfig({ banks: [{ ...bank, disposition: 'needs_review' }] });
    expect(
      parseSms(
        'Purchase Card **1234 Amount SAR 25',
        new Date().toISOString(),
        banks,
        'ExampleBank',
        parsing,
      ),
    ).toEqual({ type: 'needs_review', reason: 'unsupported_sender' });
  });

  it.each([
    ['duplicate IDs', [bank, { ...bank, senders: ['Different'] }], 'Duplicate bank ID'],
    [
      'case-insensitive duplicate aliases',
      [bank, { id: 'other', name: 'Other', senders: ['EXAMPLE   BANK'] }],
      'Duplicate sender alias',
    ],
    [
      'duplicate message aliases',
      [bank, { id: 'other', name: 'Other', senders: ['Other'], messageAliases: ['EXAMPLE BANK'] }],
      'Duplicate message alias',
    ],
    ['empty aliases', [{ ...bank, senders: [' '] }], 'at least 1 character'],
    ['invalid IDs', [{ ...bank, id: 'Invalid ID' }], 'Invalid'],
    ['unknown settings', [{ ...bank, sender: ['Typo'] }], 'Unrecognized key'],
  ])('rejects %s', (_name, banks, error) => {
    expect(() => parseBankConfig({ banks })).toThrow(error);
  });

  it('rejects account routes referencing unknown or review-only bank IDs', async () => {
    const path = await writeConfig('accounts.yaml', accountYaml());
    await expect(loadConfigFile(path, [])).rejects.toThrow('Unknown bank ID');
    const banks = parseBankConfig({ banks: [{ ...bank, disposition: 'needs_review' }] });
    await expect(loadConfigFile(path, banks)).rejects.toThrow('review-only bank');
  });
});
