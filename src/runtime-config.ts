import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { parseAccountConfig, parseBankConfig } from './config.js';
import { compileParserConfig, validateTemplateReferences } from './parsing/config.js';
import type { ActualAdapter, ResolvedConfig } from './types.js';
import { resolveConfig as resolveSnapshot } from './resolve-config.js';

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
  try {
    return resolveSnapshot(file, banks, parsing, accounts, categories);
  } catch (error) {
    throw new ConfigurationError(error instanceof Error ? error.message : 'Invalid configuration');
  }
}
