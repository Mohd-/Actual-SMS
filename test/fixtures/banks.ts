import { loadBankConfigFile } from '../../src/config.js';

export const banks = await loadBankConfigFile(
  new URL('../../config/banks.yaml', import.meta.url).pathname,
);
