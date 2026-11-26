import type {
  AccountsFileView,
  BanksFileView,
  ConfigPatch,
  ParsingFileView,
  PayeePage,
} from '../contracts.js';
import type { BankConfig, TxKind } from '../../types.js';
import type { PayeeView } from '../../payees.js';
import { categoryDisplayName } from './format.js';

export interface MatchDraft {
  bank: string;
  accountSuffixes?: string[];
  transferIdentifiers?: string[];
  billPaymentIdentifiers?: string[];
  transactionKinds?: TxKind[];
  hasBalance?: boolean;
}
export interface RuleDraft {
  key: string;
  sourceIndex?: number;
  actualName: string;
  match: MatchDraft;
}
export interface BankDraft {
  key: string;
  sourceIndex?: number;
  id: string;
  name: string;
  senders: string[];
  messageAliases: string[];
  disposition: 'import' | 'needs_review';
  templates: string[];
}
export interface PatchPlan {
  patches: ConfigPatch[];
  summary: string[];
}

export function draftKey() {
  return crypto.randomUUID();
}

export function groupRules(rules: RuleDraft[]) {
  const groups: { name: string; rules: RuleDraft[] }[] = [];
  for (const rule of rules) {
    const existing = groups.find(group => group.name === rule.actualName);
    if (existing) existing.rules.push(rule);
    else groups.push({ name: rule.actualName, rules: [rule] });
  }
  return groups;
}

export function rulesFromAccounts(file: AccountsFileView | undefined): RuleDraft[] {
  return (file?.accounts ?? []).map((rule, index) => ({
    key: draftKey(),
    sourceIndex: index,
    actualName: rule.actualName,
    match: {
      bank: rule.match.bank,
      ...(rule.match.accountSuffixes ? { accountSuffixes: [...rule.match.accountSuffixes] } : {}),
      ...(rule.match.transferIdentifiers
        ? { transferIdentifiers: [...rule.match.transferIdentifiers] }
        : {}),
      ...(rule.match.billPaymentIdentifiers
        ? { billPaymentIdentifiers: [...rule.match.billPaymentIdentifiers] }
        : {}),
      ...(rule.match.transactionKinds
        ? { transactionKinds: [...rule.match.transactionKinds] }
        : {}),
      ...(rule.match.hasBalance !== undefined ? { hasBalance: rule.match.hasBalance } : {}),
    },
  }));
}

function cleanMatch(match: MatchDraft) {
  return {
    bank: match.bank,
    ...(match.accountSuffixes?.length ? { accountSuffixes: match.accountSuffixes } : {}),
    ...(match.transferIdentifiers?.length
      ? { transferIdentifiers: match.transferIdentifiers }
      : {}),
    ...(match.billPaymentIdentifiers?.length
      ? { billPaymentIdentifiers: match.billPaymentIdentifiers }
      : {}),
    ...(match.transactionKinds?.length ? { transactionKinds: match.transactionKinds } : {}),
    ...(match.hasBalance !== undefined ? { hasBalance: match.hasBalance } : {}),
  };
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export interface AccountOptions {
  bankFeesCategory: string;
  eligibleCategories?: string[];
}

export function planAccountPatches(
  original: AccountsFileView | undefined,
  rules: RuleDraft[],
  options: AccountOptions,
): PatchPlan {
  const patches: ConfigPatch[] = [];
  const summary: string[] = [];
  const oldRules = original?.accounts ?? [];
  const kept = new Set(
    rules.flatMap(rule => (rule.sourceIndex === undefined ? [] : [rule.sourceIndex])),
  );
  const inserts: ConfigPatch[] = [];
  for (const rule of rules) {
    const cleaned = cleanMatch(rule.match);
    if (rule.sourceIndex === undefined) {
      inserts.push({
        file: 'accounts',
        op: 'insert',
        path: ['accounts'],
        value: { actualName: rule.actualName, match: cleaned },
      });
      summary.push(`Add routing rule for “${rule.actualName || 'unnamed account'}”`);
      continue;
    }
    const before = oldRules[rule.sourceIndex];
    if (!before) continue;
    const prefix = ['accounts', rule.sourceIndex] as (string | number)[];
    if (before.actualName !== rule.actualName) {
      patches.push({
        file: 'accounts',
        op: 'set',
        path: [...prefix, 'actualName'],
        value: rule.actualName,
      });
      summary.push(`Rename “${before.actualName}” to “${rule.actualName || 'unnamed account'}”`);
    }
    const fields = [
      'bank',
      'accountSuffixes',
      'transferIdentifiers',
      'billPaymentIdentifiers',
      'transactionKinds',
      'hasBalance',
    ] as const;
    for (const field of fields) {
      const next = cleaned[field];
      const previous = before.match[field];
      if (same(next, previous)) continue;
      if (next === undefined) {
        patches.push({ file: 'accounts', op: 'delete', path: [...prefix, 'match', field] });
      } else {
        patches.push({
          file: 'accounts',
          op: 'set',
          path: [...prefix, 'match', field],
          value: next,
        });
      }
      summary.push(
        `Update “${rule.actualName || 'unnamed account'}” ${field.replaceAll(/([A-Z])/g, ' $1').toLowerCase()}`,
      );
    }
  }
  for (let index = oldRules.length - 1; index >= 0; index--) {
    if (kept.has(index)) continue;
    patches.push({ file: 'accounts', op: 'delete', path: ['accounts', index] });
    summary.push(`Remove routing rule for “${oldRules[index]!.actualName}”`);
  }
  patches.push(...inserts);
  if (options.bankFeesCategory !== (original?.bankFeesCategory ?? '')) {
    patches.push({
      file: 'accounts',
      op: 'set',
      path: ['bankFeesCategory'],
      value: options.bankFeesCategory,
    });
    summary.push(`Set bank fees category to “${options.bankFeesCategory}”`);
  }
  if (!same(options.eligibleCategories, original?.eligibleCategories)) {
    if (options.eligibleCategories === undefined) {
      patches.push({ file: 'accounts', op: 'delete', path: ['eligibleCategories'] });
    } else {
      patches.push({
        file: 'accounts',
        op: 'set',
        path: ['eligibleCategories'],
        value: options.eligibleCategories,
      });
    }
    summary.push('Update eligible categories');
  }
  return { patches, summary: [...new Set(summary)] };
}

export function banksFromConfig(file: BanksFileView | undefined): BankDraft[] {
  return (file?.banks ?? []).map((bank, index) => ({
    key: draftKey(),
    sourceIndex: index,
    id: bank.id,
    name: bank.name,
    senders: [...(bank.senders ?? [])],
    messageAliases: [...(bank.messageAliases ?? [])],
    disposition: bank.disposition,
    templates: [...(bank.templates ?? [])],
  }));
}

export function planBankPatches(
  original: BanksFileView | undefined,
  banks: BankDraft[],
): PatchPlan {
  const patches: ConfigPatch[] = [];
  const summary: string[] = [];
  const oldBanks = original?.banks ?? [];
  const kept = new Set(
    banks.flatMap(bank => (bank.sourceIndex === undefined ? [] : [bank.sourceIndex])),
  );
  const inserts: ConfigPatch[] = [];
  for (const bank of banks) {
    if (bank.sourceIndex === undefined) {
      inserts.push({
        file: 'banks',
        op: 'insert',
        path: ['banks'],
        value: {
          id: bank.id,
          name: bank.name,
          senders: bank.senders,
          messageAliases: bank.messageAliases,
          disposition: bank.disposition,
          ...(bank.templates.length ? { templates: bank.templates } : {}),
        },
      });
      summary.push(`Add bank “${bank.name || bank.id || 'unnamed bank'}”`);
      continue;
    }
    const before = oldBanks[bank.sourceIndex];
    if (!before) continue;
    const prefix = ['banks', bank.sourceIndex] as (string | number)[];
    const fields = ['name', 'senders', 'messageAliases', 'disposition', 'templates'] as const;
    for (const field of fields) {
      const next = field === 'templates' && !bank.templates.length ? undefined : bank[field];
      const previous =
        field === 'templates' && !before.templates?.length ? undefined : before[field];
      if (same(next, previous)) continue;
      if (next === undefined) {
        patches.push({ file: 'banks', op: 'delete', path: [...prefix, field] });
      } else {
        patches.push({ file: 'banks', op: 'set', path: [...prefix, field], value: next });
      }
      summary.push(
        `Update ${field.replaceAll(/([A-Z])/g, ' $1').toLowerCase()} for “${bank.name || before.name}”`,
      );
    }
  }
  for (let index = oldBanks.length - 1; index >= 0; index--) {
    if (kept.has(index)) continue;
    patches.push({ file: 'banks', op: 'delete', path: ['banks', index] });
    summary.push(`Remove bank “${oldBanks[index]!.name}”`);
  }
  patches.push(...inserts);
  return { patches, summary: [...new Set(summary)] };
}

export function payeeState(row: PayeeView) {
  const states: { label: string; tone: 'neutral' | 'warning' | 'danger' | 'accent' }[] = [];
  if (row.unavailable) states.push({ label: 'Unavailable', tone: 'danger' });
  if (row.conflict.length) states.push({ label: 'Migration conflict', tone: 'warning' });
  if (!row.actualId) states.push({ label: 'Local', tone: 'accent' });
  return states;
}

export function payeeCategoryLabel(row: PayeeView, page: PayeePage) {
  if (!row.categoryId) return 'No category';
  const category = page.categories.find(item => item.id === row.categoryId);
  return category
    ? categoryDisplayName(category, page.categories)
    : `Unavailable category (${row.categoryId})`;
}

export function payeeTagLabel(id: string, page: PayeePage) {
  const tag = page.tags.find(item => item.id === id);
  return tag ? `#${tag.name}` : 'Unavailable tag';
}

export function payeeDescriptorSummary(row: PayeeView) {
  if (!row.aliases.length) return 'No descriptors';
  const names = row.aliases.slice(0, 2).map(alias => alias.name);
  return row.aliases.length > 2
    ? `${names.join(', ')} +${row.aliases.length - 2}`
    : names.join(', ');
}

export function bankOptionLabel(bank: Pick<BankConfig, 'id' | 'name' | 'disposition'>) {
  return bank.disposition === 'needs_review' ? `${bank.name} (review only)` : bank.name;
}

export interface PatternDraft {
  key: string;
  source: string;
  flags: string;
}
export interface ParsingRuleDraft {
  key: string;
  sourceIndex?: number;
  value: string;
  patterns: PatternDraft[];
}
export interface ParsingFieldDraft {
  name: string;
  patterns: PatternDraft[];
}
export interface ParsingTemplateDraft {
  key: string;
  sourceIndex?: number;
  id: string;
  kind: string;
  required: string[];
  match: PatternDraft[];
  fields: ParsingFieldDraft[];
}
export interface ParsingDraft {
  ignored: ParsingRuleDraft[];
  kinds: ParsingRuleDraft[];
  fields: ParsingFieldDraft[];
  templates: ParsingTemplateDraft[];
}

function patternsFrom(patterns: { source: string; flags: string }[] | undefined): PatternDraft[] {
  return (patterns ?? []).map(pattern => ({
    key: draftKey(),
    source: pattern.source,
    flags: pattern.flags,
  }));
}

function plainPatterns(patterns: PatternDraft[]) {
  return patterns.map(({ source, flags }) => ({ source, flags }));
}

export function parsingFromConfig(
  file: Pick<ParsingFileView, 'shared' | 'templates'> | undefined,
): ParsingDraft {
  return {
    ignored: (file?.shared.ignored ?? []).map((rule, index) => ({
      key: draftKey(),
      sourceIndex: index,
      value: rule.value,
      patterns: patternsFrom(rule.patterns),
    })),
    kinds: (file?.shared.kinds ?? []).map((rule, index) => ({
      key: draftKey(),
      sourceIndex: index,
      value: rule.value,
      patterns: patternsFrom(rule.patterns),
    })),
    fields: Object.entries(file?.shared.fields ?? {}).map(([name, patterns]) => ({
      name,
      patterns: patternsFrom(patterns),
    })),
    templates: (file?.templates ?? []).map((template, index) => ({
      key: draftKey(),
      sourceIndex: index,
      id: template.id,
      kind: template.kind,
      required: [...(template.required ?? [])],
      match: patternsFrom(template.match),
      fields: Object.entries(template.fields ?? {}).map(([name, patterns]) => ({
        name,
        patterns: patternsFrom(patterns),
      })),
    })),
  };
}

function planParsingRuleList(
  file: 'ignored' | 'kinds',
  original: { value: string; patterns: { source: string; flags: string }[] }[],
  draft: ParsingRuleDraft[],
  patches: ConfigPatch[],
  summary: string[],
) {
  const existing = draft.filter(rule => rule.sourceIndex !== undefined);
  const kept = new Set(existing.map(rule => rule.sourceIndex!));
  const ordered = [...kept].sort((left, right) => left - right);
  const newBeforeExisting = draft.some(
    (rule, index) =>
      rule.sourceIndex === undefined &&
      draft.slice(index + 1).some(next => next.sourceIndex !== undefined),
  );
  if (
    !same(
      existing.map(rule => rule.sourceIndex),
      ordered,
    ) ||
    newBeforeExisting
  ) {
    patches.push({
      file: 'parsing',
      op: 'set',
      path: ['shared', file],
      value: draft.map(rule => ({
        value: rule.value,
        patterns: plainPatterns(rule.patterns),
      })),
    });
    summary.push(`Reorder or insert ${file} rules`);
    return;
  }
  const inserts: ConfigPatch[] = [];
  for (const rule of draft) {
    if (rule.sourceIndex === undefined) {
      inserts.push({
        file: 'parsing',
        op: 'insert',
        path: ['shared', file],
        value: { value: rule.value, patterns: plainPatterns(rule.patterns) },
      });
      summary.push(`Add ${file} rule “${rule.value}”`);
      continue;
    }
    const before = original[rule.sourceIndex];
    if (!before) continue;
    const prefix = ['shared', file, rule.sourceIndex] as (string | number)[];
    if (before.value !== rule.value) {
      patches.push({ file: 'parsing', op: 'set', path: [...prefix, 'value'], value: rule.value });
      summary.push(`Change ${file} rule “${before.value}” to “${rule.value}”`);
    }
    if (!same(plainPatterns(rule.patterns), before.patterns)) {
      patches.push({
        file: 'parsing',
        op: 'set',
        path: [...prefix, 'patterns'],
        value: plainPatterns(rule.patterns),
      });
      summary.push(`Update patterns for ${file} rule “${rule.value}”`);
    }
  }
  for (let index = original.length - 1; index >= 0; index--) {
    if (kept.has(index)) continue;
    patches.push({ file: 'parsing', op: 'delete', path: ['shared', file, index] });
    summary.push(`Remove ${file} rule “${original[index]!.value}”`);
  }
  patches.push(...inserts);
}

export function planParsingPatches(
  original: Pick<ParsingFileView, 'shared' | 'templates'> | undefined,
  draft: ParsingDraft,
): PatchPlan {
  const patches: ConfigPatch[] = [];
  const summary: string[] = [];
  planParsingRuleList('ignored', original?.shared.ignored ?? [], draft.ignored, patches, summary);
  planParsingRuleList('kinds', original?.shared.kinds ?? [], draft.kinds, patches, summary);
  for (const field of draft.fields) {
    const before = original?.shared.fields?.[field.name] ?? [];
    if (!same(plainPatterns(field.patterns), before))
      patches.push({
        file: 'parsing',
        op: 'set',
        path: ['shared', 'fields', field.name],
        value: plainPatterns(field.patterns),
      });
  }
  if (
    draft.fields.some(
      field => !same(plainPatterns(field.patterns), original?.shared.fields?.[field.name] ?? []),
    )
  )
    summary.push('Update shared extractor patterns');
  const oldTemplates = original?.templates ?? [];
  const keptTemplates = new Set(
    draft.templates.flatMap(template =>
      template.sourceIndex === undefined ? [] : [template.sourceIndex],
    ),
  );
  const templateInserts: ConfigPatch[] = [];
  for (const template of draft.templates) {
    const fields = Object.fromEntries(
      template.fields
        .filter(field => field.patterns.length)
        .map(field => [field.name, plainPatterns(field.patterns)]),
    );
    if (template.sourceIndex === undefined) {
      templateInserts.push({
        file: 'parsing',
        op: 'insert',
        path: ['templates'],
        value: {
          id: template.id,
          match: plainPatterns(template.match),
          kind: template.kind,
          fields,
          required: template.required,
        },
      });
      summary.push(`Add template “${template.id || 'unnamed'}”`);
      continue;
    }
    const before = oldTemplates[template.sourceIndex];
    if (!before) continue;
    const prefix = ['templates', template.sourceIndex] as (string | number)[];
    for (const field of ['kind', 'required'] as const) {
      if (same(template[field], before[field])) continue;
      patches.push({
        file: 'parsing',
        op: 'set',
        path: [...prefix, field],
        value: template[field],
      });
    }
    if (!same(plainPatterns(template.match), before.match)) {
      patches.push({
        file: 'parsing',
        op: 'set',
        path: [...prefix, 'match'],
        value: plainPatterns(template.match),
      });
    }
    if (!same(fields, before.fields)) {
      if (Object.keys(fields).length)
        patches.push({ file: 'parsing', op: 'set', path: [...prefix, 'fields'], value: fields });
      else patches.push({ file: 'parsing', op: 'delete', path: [...prefix, 'fields'] });
    }
    if (
      patches.some(
        patch =>
          patch.path[0] === 'templates' &&
          patch.path[1] === template.sourceIndex &&
          patch.path[2] !== 'id',
      )
    )
      summary.push(`Update template “${template.id}”`);
  }
  for (let index = oldTemplates.length - 1; index >= 0; index--) {
    if (keptTemplates.has(index)) continue;
    patches.push({ file: 'parsing', op: 'delete', path: ['templates', index] });
    summary.push(`Remove template “${oldTemplates[index]!.id}”`);
  }
  patches.push(...templateInserts);
  return { patches, summary: [...new Set(summary)] };
}
