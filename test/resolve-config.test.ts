import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/resolve-config.js';
import type { AppConfigFile, ActualCategory } from '../src/types.js';
import { banks, parsing } from './fixtures/banks.js';

const file: AppConfigFile = {
  accounts: [{ actualName: 'Checking', match: { bank: 'sab', accountSuffixes: ['1234'] } }],
  bankFeesCategory: 'Fees',
  eligibleCategories: ['Shopping'],
};
const accounts = [{ id: 'account', name: 'Checking' }];
const categories: ActualCategory[] = [
  { id: 'fees', name: 'Fees' },
  { id: 'shopping', name: 'Shopping' },
];
const resolve = (values = categories, settings = file, availableAccounts = accounts) =>
  resolveConfig(settings, banks, parsing, availableAccounts, values);

describe('startup name resolution', () => {
  it.each(['missing', 'duplicate'])('rejects a %s configured enrichment category', kind => {
    const values =
      kind === 'missing'
        ? [categories[0]!]
        : kind === 'duplicate'
          ? [...categories, { id: 'other', name: 'Shopping', groupName: 'Another Group' }]
          : [
              categories[0]!,
              { ...categories[1]!, hidden: kind === 'hidden', isIncome: kind === 'income' },
            ];
    expect(() => resolve(values)).toThrow(
      'Active expense category must resolve exactly once: Shopping',
    );
  });

  it.each(['hidden', 'income'])(
    'excludes a configured %s category with a warning while preserving settings',
    kind => {
      const values = [
        categories[0]!,
        { ...categories[1]!, hidden: kind === 'hidden', isIncome: kind === 'income' },
      ];
      const warnings: string[] = [];
      const result = resolveConfig(file, banks, parsing, accounts, values, {
        warn: message => warnings.push(message),
      });
      expect(result.eligibleCategories).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(file.eligibleCategories).toEqual(['Shopping']);
    },
  );
  it('uses only active expense categories by default', () => {
    const result = resolve(
      [
        ...categories,
        { id: 'income', name: 'Salary', isIncome: true },
        { id: 'hidden', name: 'Old', hidden: true },
      ],
      { ...file, eligibleCategories: undefined },
    );
    expect(result.eligibleCategories).toEqual([{ id: 'shopping', name: 'Shopping' }]);
    expect(result.accounts[0]?.id).toBe('account');
  });
  it('rejects an inactive fee category and prevents AI from selecting bank fees', () => {
    expect(() => resolve([{ ...categories[0]!, hidden: true }, categories[1]!])).toThrow(
      'Active expense category must resolve exactly once: Fees',
    );
    expect(() => resolve(categories, { ...file, eligibleCategories: ['Fees'] })).toThrow(
      'Bank Fees cannot be an enrichment category',
    );
  });
  it('rejects missing or ambiguous account names', () => {
    expect(() => resolve(categories, file, [])).toThrow(
      'Actual account must resolve exactly once: Checking',
    );
    expect(() =>
      resolve(categories, file, [...accounts, { id: 'other', name: 'Checking' }]),
    ).toThrow('Actual account must resolve exactly once: Checking');
  });
});
