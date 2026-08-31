import { describe, expect, it } from 'vitest';
import { validateAccountRules } from '../src/config.js';
import { parseSms } from '../src/parser.js';
import {
  resolveAccount,
  resolveBillPaymentAccount,
  resolveTransferAccount,
} from '../src/routing.js';
import type { ResolvedAccount } from '../src/types.js';

const accounts: ResolvedAccount[] = [
  {
    key: 'sab-checking',
    id: 'sab-checking-id',
    name: 'SampleLedger1',
    match: { bank: 'sab', accountSuffixes: ['4101', '101', '4187'] },
  },
  {
    key: 'payroll',
    id: 'payroll-id',
    name: 'SampleLedger2',
    match: {
      bank: 'sab',
      accountSuffixes: ['5202', '202'],
    },
  },
  {
    key: 'credit-card',
    id: 'credit-card-id',
    name: 'SampleLedger4',
    match: {
      bank: 'alrajhi',
      hasBalance: true,
      transferIdentifiers: ['6303'],
      billPaymentIdentifiers: ['404'],
    },
  },
  {
    key: 'alrajhi-checking',
    id: 'alrajhi-checking-id',
    name: 'Alrajhi Checking',
    match: { bank: 'alrajhi', hasBalance: false, transferIdentifiers: ['7404'] },
  },
];

describe('account routing', () => {
  const receivedAt = '2026-08-22T10:10:30+03:00';

  it.each([
    ['SAB purchase Card **4101 Amount SAR 1 at Example Store on 2026-08-22 10:05', 'sab-checking'],
    ['SAB purchase Card **5202 Amount SAR 1 at Example Store on 2026-08-22 10:05', 'payroll'],
    ['SAB online Card **4187 Amount SAR 1 at Example Store on 2026-08-22 10:05', 'sab-checking'],
    ['SAB refund account **101 amount SAR 1 at Example Store on 2026-08-22 10:05', 'sab-checking'],
    ['SAB refund account **202 amount SAR 1 at Example Store on 2026-08-22 10:05', 'payroll'],
    ['SAB outgoing transfer account **5202 amount SAR 1 to SampleLedger2 on 2026-08-22 10:05', 'payroll'],
    ['SAB transfer received From: 4101 To: 5202 Amount SAR 1 on 2026-08-22 10:05', 'payroll'],
    ['SAB ATM withdrawal account **4187 amount SAR 1 on 2026-08-22 10:05', 'sab-checking'],
    ['SAB ATM withdrawal account **202 amount SAR 1 on 2026-08-22 10:05', 'payroll'],
    ['SAB card payment From: 101 To: 7404 Amount: SAR 1', 'sab-checking'],
    ['SAB card payment From: 202 To: 7404 Amount: SAR 1', 'payroll'],
    ['SAB transfer received From: 4101 To: 101 Amount: SAR 1', 'sab-checking'],
    ['SAB حوالة راتب إلى: **202 مبلغ: 25,559.77 SAR في: 2026-08-26 08:02:50', 'payroll'],
    [
      'Al Rajhi purchase amount SAR 1 at Example Store on 2026-08-22 10:05 current balance SAR 100',
      'credit-card',
    ],
    ['Al Rajhi purchase amount SAR 1 at Example Store on 2026-08-22 10:05', 'alrajhi-checking'],
  ])('routes %s to %s', (message, key) => {
    const result = parseSms(message, receivedAt);
    if (result.type !== 'transaction') throw new Error(`Expected transaction, got ${result.type}`);
    const transaction = result.transaction;
    expect(resolveAccount(accounts, transaction)?.key).toBe(key);
  });

  it('rejects overlapping rules before startup', () =>
    expect(() =>
      validateAccountRules([
        { actualName: 'One', match: { bank: 'sab', accountSuffixes: ['4101'] } },
        { actualName: 'Two', match: { bank: 'sab', accountSuffixes: ['4101'] } },
      ]),
    ).toThrow('Ambiguous account rules'));

  it('uses every bank when resolving a transfer destination', () => {
    expect(resolveTransferAccount(accounts, '6303')?.key).toBe('credit-card');
    expect(resolveTransferAccount(accounts, '7404')?.key).toBe('alrajhi-checking');
    expect(resolveTransferAccount(accounts, '202')?.key).toBe('payroll');
  });

  it('keeps biller identifiers out of ordinary transfer resolution', () => {
    expect(resolveTransferAccount(accounts, '404')).toBeUndefined();
    expect(resolveBillPaymentAccount(accounts, '404')?.key).toBe('credit-card');
  });

  it('collapses multiple rules for the same Actual account when resolving transfers', () => {
    const rules: ResolvedAccount[] = [
      {
        key: 'checking',
        id: 'checking-id',
        name: 'Checking',
        match: { bank: 'sab', accountSuffixes: ['101'] },
      },
      {
        key: 'checking',
        id: 'checking-id',
        name: 'Checking',
        match: { bank: 'alrajhi', transferIdentifiers: ['101'] },
      },
    ];
    expect(resolveTransferAccount(rules, '101')?.key).toBe('checking');
  });

  it('rejects transfer identifiers assigned to different Actual accounts', () =>
    expect(() =>
      resolveTransferAccount(
        [
          { ...accounts[0]!, match: { bank: 'sab', transferIdentifiers: ['999'] } },
          { ...accounts[2]!, match: { bank: 'sab', transferIdentifiers: ['999'] } },
        ],
        '999',
      ),
    ).toThrow('Ambiguous transfer account identifier'));
});
