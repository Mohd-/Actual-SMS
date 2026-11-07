import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { parseAccountConfig, parseBankConfig } from './config.js';
import { compileParserConfig, validateTemplateReferences } from './parsing/config.js';
import type { ActualAdapter, ResolvedConfig } from './types.js';

export interface ConfigPaths {
  accounts: string;
  banks: string;
  parsing: string;
}
export interface ConfigFiles {
  accounts: string;
  banks: string;
  parsing: string;
}
export class ConfigurationError extends Error {}
export async function readConfigFiles(paths: ConfigPaths): Promise<ConfigFiles> {
  const [accounts, banks, parsing] = await Promise.all(
    [paths.accounts, paths.banks, paths.parsing].map(path => readFile(path, 'utf8')),
  );
  return { accounts: accounts!, banks: banks!, parsing: parsing! };
}
export const configRevision = (files: ConfigFiles) =>
  createHash('sha256')
    .update(JSON.stringify([files.accounts, files.banks, files.parsing]))
    .digest('hex');
export function parseConfigFiles(files: ConfigFiles) {
  try {
    const banks = parseBankConfig(YAML.parse(files.banks));
    const parsing = compileParserConfig(YAML.parse(files.parsing));
    validateTemplateReferences(banks, parsing);
    const file = parseAccountConfig(YAML.parse(files.accounts), banks);
    return { banks, parsing, file };
  } catch (error) {
    throw new ConfigurationError(error instanceof Error ? error.message : 'Invalid configuration');
  }
}
export async function resolveConfig(
  files: ConfigFiles,
  actual: ActualAdapter,
): Promise<ResolvedConfig> {
  const { banks, parsing, file } = parseConfigFiles(files);
  const [accounts, categories] = await Promise.all([actual.accounts(), actual.categories()]);
  const one = <T extends { name: string }>(items: T[], name: string, label: string): T => {
    const matches = items.filter(item => item.name === name);
    if (matches.length !== 1)
      throw new ConfigurationError(`${label} must resolve exactly once: ${name}`);
    return matches[0]!;
  };
  const resolved = file.accounts.map(mapping => {
    const account = one(accounts, mapping.actualName, 'Actual account');
    return { key: account.id, ...account, match: mapping.match };
  });
  const fee = one(categories, file.bankFeesCategory, 'Bank Fees category');
  file.eligibleCategories?.forEach(name => one(categories, name, 'Eligible category'));
  const eligible = file.eligibleCategories?.length
    ? categories.filter(c => file.eligibleCategories!.includes(c.name))
    : categories.filter(c => c.name !== file.bankFeesCategory);
  return {
    banks,
    parsing,
    accounts: resolved,
    bankFeesCategoryId: fee.id,
    eligibleCategories: eligible.map(({ id, name }) => ({ id, name })),
  };
}
