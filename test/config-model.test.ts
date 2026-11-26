import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { applyConfigPatches, modelFromFiles } from '../src/management/config-model.js';
import type { ConfigFiles } from '../src/runtime-config.js';

const files: ConfigFiles = {
  accounts: `# top comment
accounts:
  # first comment
  - actualName: Checking # trailing
    match:
      bank: sab
      accountSuffixes: ['1234']
bankFeesCategory: Bank Fees # fee comment
privateOperatorNote: keep-me
`,
  banks: `banks:
  - id: sab
    name: SAB
    senders: [SAB]
    messageAliases: []
    disposition: import
`,
  parsing: `schemaVersion: 1
shared:
  ignored:
    - value: otp_or_login
      patterns:
        - source: otp
          flags: iu
  kinds:
    - value: purchase
      patterns:
        - source: purchase
          flags: iu
  fields:
    merchant:
      - source: merchant (?<value>.+)
        flags: iu
templates: []
`,
};
const accounts = (text: string) => YAML.parse(text) as Record<string, unknown>;
const banks = (text: string) => YAML.parse(text) as Record<string, unknown>;
const parsing = (text: string) => YAML.parse(text) as Record<string, unknown>;

describe('structured configuration patches', () => {
  it('updates account fields while preserving comments and unrelated keys', () => {
    const text = applyConfigPatches(files, 'accounts', [
      {
        file: 'accounts',
        op: 'set',
        path: ['accounts', 0, 'match', 'accountSuffixes'],
        value: ['4321'],
      },
      {
        file: 'accounts',
        op: 'set',
        path: ['accounts', 0, 'actualName'],
        value: 'Checking 2',
      },
    ]);
    expect(text).toContain('# top comment');
    expect(text).toContain('# first comment');
    expect(text).toContain('# trailing');
    expect(text).toContain('# fee comment');
    expect(text).toContain('privateOperatorNote: keep-me');
    expect(accounts(text).accounts).toEqual([
      { actualName: 'Checking 2', match: { bank: 'sab', accountSuffixes: ['4321'] } },
    ]);
  });

  it('inserts, deletes, and moves list entries', () => {
    const accountsText = applyConfigPatches(files, 'accounts', [
      {
        file: 'accounts',
        op: 'insert',
        path: ['accounts'],
        value: { actualName: 'Savings', match: { bank: 'sab', hasBalance: true } },
      },
      { file: 'accounts', op: 'delete', path: ['accounts', 0] },
    ]);
    expect(accounts(accountsText).accounts).toEqual([
      { actualName: 'Savings', match: { bank: 'sab', hasBalance: true } },
    ]);
    const bankText = applyConfigPatches(files, 'banks', [
      {
        file: 'banks',
        op: 'insert',
        path: ['banks'],
        value: {
          id: 'stc',
          name: 'STC',
          senders: ['STC'],
          messageAliases: [],
          disposition: 'import',
        },
      },
      { file: 'banks', op: 'move', path: ['banks'], from: 1, to: 0 },
    ]);
    expect((banks(bankText).banks as { id: string }[]).map(bank => bank.id)).toEqual([
      'stc',
      'sab',
    ]);
    const parsingText = applyConfigPatches(files, 'parsing', [
      {
        file: 'parsing',
        op: 'insert',
        path: ['shared', 'kinds'],
        value: { value: 'refund', patterns: [{ source: 'refund', flags: 'iu' }] },
      },
      { file: 'parsing', op: 'move', path: ['shared', 'kinds'], from: 1, to: 0 },
    ]);
    expect(
      (parsing(parsingText).shared as { kinds: { value: string }[] }).kinds.map(rule => rule.value),
    ).toEqual(['refund', 'purchase']);
  });

  it('rejects unknown paths, mismatched files, and malformed moves', () => {
    expect(() =>
      applyConfigPatches(files, 'accounts', [
        { file: 'accounts', op: 'set', path: ['unknown'], value: true },
      ]),
    ).toThrow('not allowed');
    expect(() =>
      applyConfigPatches(files, 'accounts', [
        { file: 'banks', op: 'set', path: ['banks', 0, 'name'], value: 'x' },
      ]),
    ).toThrow('different file');
    expect(() =>
      applyConfigPatches(files, 'banks', [
        { file: 'banks', op: 'move', path: ['banks'], from: 0, to: 4 },
      ]),
    ).toThrow('out of range');
  });

  it('inserts the first templates when the optional list is omitted', () => {
    const withoutTemplates = { ...files, parsing: files.parsing.replace('templates: []\n', '') };
    const templates = ['first', 'second'].map(id => ({
      id,
      kind: 'purchase',
      match: [{ source: id, flags: 'iu' }],
      fields: {},
      required: [],
    }));
    const text = applyConfigPatches(
      withoutTemplates,
      'parsing',
      templates.map(value => ({ file: 'parsing', op: 'insert', path: ['templates'], value })),
    );
    expect(parsing(text).templates).toEqual(templates);
    expect(parsing(text).shared).toEqual(parsing(files.parsing).shared);
  });

  it('extracts the editable model from all three files', () => {
    const model = modelFromFiles(files);
    expect(model.accounts.bankFeesCategory).toBe('Bank Fees');
    expect(model.banks.banks[0]?.id).toBe('sab');
    expect(model.parsing.schemaVersion).toBe(1);
  });
});
