import { describe, expect, it } from 'vitest';
import { directionOf } from '../src/management/web/dom.js';
import {
  categoryDisplayName,
  formatAmount,
  reasonLabel,
  statusLabel,
} from '../src/management/web/format.js';
import {
  groupRules,
  payeeCategoryLabel,
  payeeDescriptorSummary,
  payeeState,
  planAccountPatches,
  planBankPatches,
  planParsingPatches,
  parsingFromConfig,
  rulesFromAccounts,
  banksFromConfig,
} from '../src/management/web/models.js';
import { pageTitle, parseRoute, routeHref } from '../src/management/web/router.js';
import type { AccountsFileView } from '../src/management/contracts.js';
import type { PayeeView } from '../src/payees.js';

const accounts: AccountsFileView = {
  accounts: [
    { actualName: 'Checking', match: { bank: 'sab', accountSuffixes: ['1234'] } },
    { actualName: 'Checking', match: { bank: 'sab', hasBalance: false } },
    { actualName: 'Savings', match: { bank: 'sab', accountSuffixes: ['5678'] } },
  ],
  bankFeesCategory: 'Fees',
};
const payee = (overrides: Partial<PayeeView> = {}): PayeeView => ({
  id: 'payee-id',
  name: 'Coffee',
  actualId: 'actual-coffee',
  unavailable: false,
  categoryId: 'food',
  tagIds: ['work'],
  conflict: [],
  revision: 'revision',
  aliases: [
    { key: 'coffee', name: 'Coffee', linked: true },
    { key: 'cafe', name: 'Cafe', linked: false },
  ],
  ...overrides,
});
const payeePage = {
  rows: [payee()],
  accounts: [{ id: 'checking', name: 'Checking' }],
  categories: [
    { id: 'food', name: 'Food', groupName: 'Living' },
    { id: 'other-food', name: 'Food', groupName: 'Other' },
    { id: 'fun', name: 'Fun' },
  ],
  tags: [{ id: 'work', name: 'work' }],
  nextOffset: null,
  editable: true,
  migrationPending: false,
  suggestions: true,
};

describe('management UI models', () => {
  it('parses and builds hash routes', () => {
    expect(parseRoute('#/events?status=failed&from=2026-01-01')).toMatchObject({
      page: 'events',
    });
    expect(parseRoute('#/config/parsing').section).toBe('parsing');
    expect(parseRoute('')).toMatchObject({ page: 'status' });
    expect(routeHref({ page: 'config', section: 'banks', query: new URLSearchParams() })).toBe(
      '#/config/banks',
    );
    expect(pageTitle(parseRoute('#/tasker'))).toBe('Phone setup');
  });

  it('detects Arabic text and formats user-facing values', () => {
    expect(directionOf('متجر-الرياض')).toBe('rtl');
    expect(directionOf('Coffee Co')).toBe('ltr');
    expect(statusLabel('needs_review')).toBe('Needs review');
    expect(reasonLabel('otp_or_login')).toBe('One-time code or login alert');
    expect(formatAmount(12345)).toContain('123.45');
    expect(
      categoryDisplayName({ id: 'food', name: 'Food', groupName: 'Living' }, payeePage.categories),
    ).toBe('Living / Food');
  });

  it('summarizes payees and their state', () => {
    const row = payee();
    expect(payeeCategoryLabel(row, payeePage)).toBe('Living / Food');
    expect(payeeDescriptorSummary(row)).toBe('Coffee, Cafe');
    expect(payeeState(row)).toEqual([]);
    expect(
      payeeState(payee({ conflict: [{ accountId: 'a', merchant: 'm', categoryId: null }] })),
    ).toEqual([{ label: 'Migration conflict', tone: 'warning' }]);
  });

  it('groups rules and builds account patches from a structured draft', () => {
    const rules = rulesFromAccounts(accounts);
    expect(groupRules(rules).map(group => [group.name, group.rules.length])).toEqual([
      ['Checking', 2],
      ['Savings', 1],
    ]);
    const draft = rules.map(rule => ({ ...rule, match: { ...rule.match } }));
    draft[0]!.actualName = 'Main Checking';
    draft[1]!.actualName = 'Main Checking';
    draft[0]!.match.accountSuffixes = ['4321'];
    draft.splice(2, 1);
    draft.push({
      key: 'new',
      actualName: 'Wallet',
      match: { bank: 'sab', hasBalance: true },
    });
    const plan = planAccountPatches(accounts, draft, {
      bankFeesCategory: 'Fees',
      eligibleCategories: ['Food'],
    });
    expect(plan.patches).toEqual(
      expect.arrayContaining([
        { file: 'accounts', op: 'delete', path: ['accounts', 2] },
        {
          file: 'accounts',
          op: 'set',
          path: ['accounts', 0, 'actualName'],
          value: 'Main Checking',
        },
        {
          file: 'accounts',
          op: 'set',
          path: ['accounts', 1, 'actualName'],
          value: 'Main Checking',
        },
        {
          file: 'accounts',
          op: 'set',
          path: ['accounts', 0, 'match', 'accountSuffixes'],
          value: ['4321'],
        },
        {
          file: 'accounts',
          op: 'insert',
          path: ['accounts'],
          value: { actualName: 'Wallet', match: { bank: 'sab', hasBalance: true } },
        },
        { file: 'accounts', op: 'set', path: ['eligibleCategories'], value: ['Food'] },
      ]),
    );
  });

  it('applies account updates before deleting lower-index rules', () => {
    const original: AccountsFileView = {
      accounts: [
        { actualName: 'First', match: { bank: 'sab', accountSuffixes: ['1111'] } },
        { actualName: 'Second', match: { bank: 'sab', accountSuffixes: ['2222'] } },
      ],
      bankFeesCategory: 'Fees',
    };
    const draft = rulesFromAccounts(original).slice(1);
    draft[0]!.match.accountSuffixes = ['3333'];
    const plan = planAccountPatches(original, draft, { bankFeesCategory: 'Fees' });
    expect(plan.patches[0]).toMatchObject({
      op: 'set',
      path: ['accounts', 1, 'match', 'accountSuffixes'],
      value: ['3333'],
    });
    expect(plan.patches.at(-1)).toMatchObject({ op: 'delete', path: ['accounts', 0] });
  });

  it('builds parsing patches for rules, fields, and templates', () => {
    const original = {
      shared: {
        ignored: [{ value: 'otp_or_login', patterns: [{ source: 'otp', flags: 'iu' }] }],
        kinds: [{ value: 'purchase', patterns: [{ source: 'purchase', flags: 'iu' }] }],
        fields: { merchant: [{ source: 'merchant (?<value>.+)', flags: 'iu' }] },
      },
      templates: [
        {
          id: 'sample',
          kind: 'purchase',
          required: [],
          match: [{ source: 'sample', flags: 'iu' }],
          fields: {},
        },
      ],
    };
    const draft = parsingFromConfig(original);
    draft.ignored[0]!.patterns.push({ key: 'new', source: 'login', flags: 'iu' });
    draft.kinds[0]!.value = 'refund';
    draft.fields[0]!.patterns = [{ key: 'field', source: 'shop (?<value>.+)', flags: 'iu' }];
    draft.templates[0]!.kind = 'refund';
    draft.templates.push({
      key: 'template',
      id: 'second',
      kind: 'purchase',
      required: ['merchant'],
      match: [{ key: 'match', source: 'second', flags: 'iu' }],
      fields: [],
    });
    const plan = planParsingPatches(original, draft);
    expect(plan.patches).toEqual(
      expect.arrayContaining([
        {
          file: 'parsing',
          op: 'set',
          path: ['shared', 'ignored', 0, 'patterns'],
          value: [
            { source: 'otp', flags: 'iu' },
            { source: 'login', flags: 'iu' },
          ],
        },
        { file: 'parsing', op: 'set', path: ['shared', 'kinds', 0, 'value'], value: 'refund' },
        {
          file: 'parsing',
          op: 'set',
          path: ['shared', 'fields', 'merchant'],
          value: [{ source: 'shop (?<value>.+)', flags: 'iu' }],
        },
        { file: 'parsing', op: 'set', path: ['templates', 0, 'kind'], value: 'refund' },
        expect.objectContaining({ file: 'parsing', op: 'insert', path: ['templates'] }),
      ]),
    );
  });

  it('builds bank patches for aliases, disposition, and removal', () => {
    const original = {
      banks: [
        {
          id: 'sab',
          name: 'SAB',
          senders: ['SAB'],
          messageAliases: [],
          disposition: 'import' as const,
        },
        {
          id: 'stc',
          name: 'STC',
          senders: ['STC'],
          messageAliases: [],
          disposition: 'needs_review' as const,
        },
      ],
    };
    const draft = banksFromConfig(original);
    draft[0]!.senders = ['SAB', 'Saudi Awwal'];
    draft[0]!.disposition = 'needs_review';
    draft.splice(1, 1);
    draft.push({
      key: 'new',
      id: 'd360',
      name: 'D360',
      senders: ['D360'],
      messageAliases: [],
      disposition: 'import',
      templates: [],
    });
    const plan = planBankPatches(original, draft);
    expect(plan.patches).toEqual(
      expect.arrayContaining([
        { file: 'banks', op: 'delete', path: ['banks', 1] },
        { file: 'banks', op: 'set', path: ['banks', 0, 'senders'], value: ['SAB', 'Saudi Awwal'] },
        { file: 'banks', op: 'set', path: ['banks', 0, 'disposition'], value: 'needs_review' },
        expect.objectContaining({ file: 'banks', op: 'insert', path: ['banks'] }),
      ]),
    );
  });
});
