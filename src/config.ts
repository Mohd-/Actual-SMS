import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';
import type { AppConfigFile, BankConfig } from './types.js';

const envSchema = z.object({
  API_KEY: z.string().min(16),
  ACTUAL_SERVER_URL: z.string().url(),
  ACTUAL_PASSWORD: z.string().min(1),
  ACTUAL_SYNC_ID: z.string().min(1),
  ACTUAL_ENCRYPTION_PASSWORD: z.string().optional(),
  OPENCODE_GO_API_KEY: z.string().optional(),
  OPENCODE_GO_MODEL: z.string().default('deepseek-v4-flash'),
  CONFIG_PATH: z.string().default('/config/accounts.yaml'),
  BANKS_CONFIG_PATH: z.string().default('/config/banks.yaml'),
  PARSING_CONFIG_PATH: z.string().default('/config/parsing.yaml'),
  DB_PATH: z.string().default('/data/events.sqlite'),
  ACTUAL_CACHE_DIR: z.string().default('/actual-cache'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default('info'),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  ENRICHMENT_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
  MAPPING_REFRESH_MINUTES: z.coerce.number().int().min(1).default(60),
});
const fileSchema = z.object({
  accounts: z
    .array(
      z.object({
        actualName: z.string().min(1),
        match: z
          .object({
            bank: z.string().regex(/^[a-z][a-z0-9_-]*$/),
            accountSuffixes: z
              .array(z.string().regex(/^\d{3,6}$/))
              .min(1)
              .optional(),
            transferIdentifiers: z
              .array(z.string().regex(/^\d{3,6}$/))
              .min(1)
              .optional(),
            billPaymentIdentifiers: z
              .array(z.string().regex(/^\d{3,6}$/))
              .min(1)
              .optional(),
            transactionKinds: z
              .array(
                z.enum([
                  'purchase',
                  'refund',
                  'withdrawal',
                  'transfer_in',
                  'transfer_out',
                  'card_payment',
                ]),
              )
              .min(1)
              .optional(),
            hasBalance: z.boolean().optional(),
          })
          .refine(
            match =>
              match.accountSuffixes || match.transactionKinds || match.hasBalance !== undefined,
            {
              message: 'Account match needs accountSuffixes, transactionKinds, or hasBalance',
            },
          ),
      }),
    )
    .min(1),
  bankFeesCategory: z.string().min(1),
  eligibleCategories: z.array(z.string()).optional(),
});
export type Env = z.infer<typeof envSchema>;
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
function overlap<T>(a: T | undefined, b: T | undefined, shared: (x: T, y: T) => boolean) {
  return a === undefined || b === undefined || shared(a, b);
}
export function validateAccountRules(accounts: AppConfigFile['accounts']) {
  for (let i = 0; i < accounts.length; i++) {
    for (let j = 0; j < i; j++) {
      const left = accounts[i]!.match;
      const right = accounts[j]!.match;
      const suffixesOverlap = overlap(left.accountSuffixes, right.accountSuffixes, (a, b) =>
        a.some(value => b.includes(value)),
      );
      const kindsOverlap = overlap(left.transactionKinds, right.transactionKinds, (a, b) =>
        a.some(value => b.includes(value)),
      );
      const balancesOverlap = overlap(left.hasBalance, right.hasBalance, (a, b) => a === b);
      if (left.bank === right.bank && suffixesOverlap && kindsOverlap && balancesOverlap) {
        throw new Error(
          `Ambiguous account rules: ${accounts[j]!.actualName} and ${accounts[i]!.actualName}`,
        );
      }
    }
  }
}
const bankFileSchema = z
  .object({
    banks: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
            name: z.string().trim().min(1),
            templates: z.array(z.string().min(1)).optional(),
            senders: z.array(z.string().trim().min(1).max(100)).min(1),
            messageAliases: z.array(z.string().trim().min(1)).default([]),
            disposition: z.enum(['import', 'needs_review']).default('import'),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export function normalizeSender(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLowerCase();
}

export function parseBankConfig(value: unknown): BankConfig[] {
  const { banks } = bankFileSchema.parse(value);
  const ids = new Set<string>();
  const senders = new Map<string, string>();
  const messageAliases = new Map<string, string>();
  for (const bank of banks) {
    if (ids.has(bank.id)) throw new Error(`Duplicate bank ID: ${bank.id}`);
    ids.add(bank.id);
    for (const [aliases, seen, label] of [
      [bank.senders, senders, 'sender alias'],
      [bank.messageAliases, messageAliases, 'message alias'],
    ] as const) {
      for (const alias of aliases) {
        const normalized = normalizeSender(alias);
        if (seen.has(normalized))
          throw new Error(`Duplicate ${label}: ${alias} (${seen.get(normalized)}, ${bank.id})`);
        seen.set(normalized, bank.id);
      }
    }
  }
  return banks;
}

export async function loadBankConfigFile(path: string): Promise<BankConfig[]> {
  return parseBankConfig(YAML.parse(await readFile(path, 'utf8')));
}

export async function loadConfigFile(path: string, banks: BankConfig[]): Promise<AppConfigFile> {
  const config = fileSchema.parse(YAML.parse(await readFile(path, 'utf8')));
  for (const account of config.accounts) {
    const bank = banks.find(bank => bank.id === account.match.bank);
    if (!bank) throw new Error(`Unknown bank ID: ${account.match.bank}`);
    if (bank.disposition !== 'import') throw new Error(`Account uses review-only bank: ${bank.id}`);
  }
  validateAccountRules(config.accounts);
  return config;
}
