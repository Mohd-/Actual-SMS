import { loadBankConfigFile } from '../../src/config.js';

export const banks = await loadBankConfigFile(
  new URL('../../config/banks.yaml', import.meta.url).pathname,
);

export const parsing = await (
  await import('../../src/parsing/config.js')
).loadParserConfig(new URL('../../config/parsing.yaml', import.meta.url).pathname, banks);
