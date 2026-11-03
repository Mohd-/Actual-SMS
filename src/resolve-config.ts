import type { ActualCategory, AppConfigFile, ResolvedConfig, BankConfig } from './types.js';
import type { ParserConfig } from './parsing/config.js';

export function resolveConfig(
  file: AppConfigFile,
  banks: BankConfig[],
  parsing: ParserConfig,
  accounts: { id: string; name: string }[],
  categories: ActualCategory[],
): ResolvedConfig {
  const active = categories.filter(category => !category.hidden && !category.isIncome);
  const category = (name: string) => {
    const matches = active.filter(value => value.name === name);
    if (matches.length !== 1)
      throw new Error(`Active expense category must resolve exactly once: ${name}`);
    return matches[0]!;
  };
  const fee = category(file.bankFeesCategory);
  const eligible = file.eligibleCategories?.length
    ? file.eligibleCategories.map(category)
    : active.filter(value => value.id !== fee.id);
  if (eligible.some(value => value.id === fee.id))
    throw new Error('Bank Fees cannot be an enrichment category');
  return {
    banks,
    parsing,
    accounts: file.accounts.map(mapping => {
      const matches = accounts.filter(account => account.name === mapping.actualName);
      if (matches.length !== 1)
        throw new Error(`Actual account must resolve exactly once: ${mapping.actualName}`);
      return { key: matches[0]!.id, ...matches[0]!, match: mapping.match };
    }),
    bankFeesCategoryId: fee.id,
    eligibleCategories: eligible.map(({ id, name }) => ({ id, name })),
  };
}
