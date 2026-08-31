import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';
import type { AppConfigFile } from './types.js';

const envSchema = z.object({
  API_KEY: z.string().min(16),
  ACTUAL_SERVER_URL: z.string().url(),
  ACTUAL_PASSWORD: z.string().min(1),
  ACTUAL_SYNC_ID: z.string().min(1),
  ACTUAL_ENCRYPTION_PASSWORD: z.string().optional(),
  OPENCODE_GO_API_KEY: z.string().optional(),
  OPENCODE_GO_MODEL: z.string().default('deepseek-v4-flash'),
  CONFIG_PATH: z.string().default('/config/accounts.yaml'),
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
            bank: z.enum(['sab', 'alrajhi']),
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
export async function loadConfigFile(path: string): Promise<AppConfigFile> {
  const config = fileSchema.parse(YAML.parse(await readFile(path, 'utf8')));
  validateAccountRules(config.accounts);
  return config;
}
