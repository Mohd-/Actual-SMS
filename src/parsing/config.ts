import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';
import type { BankConfig } from '../types.js';

const kind = z.enum([
  'purchase',
  'refund',
  'withdrawal',
  'transfer_in',
  'transfer_out',
  'card_payment',
]);
const reason = z.enum([
  'otp_or_login',
  'declined_or_insufficient_funds',
  'duplicate_fee_notification',
]);
export const fieldNames = [
  'accountAlias',
  'accountAliases',
  'from',
  'to',
  'iban',
  'beneficiary',
  'biller',
  'merchant',
  'total',
  'principal',
  'fee',
  'balance',
  'foreign',
  'date',
  'sarEquivalent',
  'cashback',
] as const;
export type Field = (typeof fieldNames)[number];
const field = z.enum(fieldNames);
const pattern = z
  .object({
    source: z.string().min(1),
    flags: z
      .string()
      .regex(/^(?!.*(.).*\1)[imsu]*$/)
      .default(''),
  })
  .strict();
const fields = z.record(field, z.array(pattern).min(1));
const schema = z
  .object({
    schemaVersion: z.literal(1),
    shared: z
      .object({
        ignored: z
          .array(z.object({ value: reason, patterns: z.array(pattern).min(1) }).strict())
          .min(1),
        kinds: z
          .array(z.object({ value: kind, patterns: z.array(pattern).min(1) }).strict())
          .min(1),
        fields,
      })
      .strict(),
    templates: z
      .array(
        z
          .object({
            id: z.string().min(1),
            match: z.array(pattern).min(1),
            kind,
            fields,
            required: z.array(field).default([]),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type CompiledFields = Partial<Record<Field, readonly RegExp[]>>;
export interface ParserConfig {
  shared: {
    ignored: { value: z.infer<typeof reason>; patterns: RegExp[] }[];
    kinds: { value: z.infer<typeof kind>; patterns: RegExp[] }[];
    fields: CompiledFields;
  };
  templates: {
    id: string;
    match: RegExp[];
    kind: z.infer<typeof kind>;
    fields: CompiledFields;
    required: Field[];
  }[];
}
export function compileParserConfig(input: unknown): ParserConfig {
  const file = schema.parse(input);
  const compile = (p: z.infer<typeof pattern>, path: string) => {
    try {
      return new RegExp(p.source, p.flags);
    } catch (error) {
      throw new Error(`${path}: ${p.source}: ${String(error)}`);
    }
  };
  const compileFields = (values: z.infer<typeof fields>, path: string): CompiledFields =>
    Object.fromEntries(
      Object.entries(values).map(([name, patterns]) => [
        name,
        patterns.map((p, index) => {
          const regex = compile(p, `${path}.${name}[${index}]`);
          if (name !== 'cashback') {
            const groups = name === 'foreign' ? ['amount', 'currency'] : ['value'];
            for (const group of groups)
              if (!p.source.replace(/\\[\s\S]|\[(?:\\.|[^\]\\])*\]/g, '').includes(`(?<${group}>`))
                throw new Error(`${path}.${name}[${index}]: missing named capture ${group}`);
          }
          return regex;
        }),
      ]),
    );
  for (const name of fieldNames)
    if (!file.shared.fields[name])
      throw new Error(`shared.fields.${name}: required shared extractor`);
  const ids = new Set<string>();
  const templates = file.templates.map(t => {
    if (ids.has(t.id)) throw new Error(`Duplicate template ID: ${t.id}`);
    ids.add(t.id);
    return {
      ...t,
      match: t.match.map((p, i) => compile(p, `templates.${t.id}.match[${i}]`)),
      fields: compileFields(t.fields, `templates.${t.id}.fields`),
    };
  });
  return {
    shared: {
      ignored: file.shared.ignored.map(r => ({
        ...r,
        patterns: r.patterns.map((p, i) => compile(p, `shared.ignored.${r.value}[${i}]`)),
      })),
      kinds: file.shared.kinds.map(r => ({
        ...r,
        patterns: r.patterns.map((p, i) => compile(p, `shared.kinds.${r.value}[${i}]`)),
      })),
      fields: compileFields(file.shared.fields, 'shared.fields'),
    },
    templates,
  };
}
export function validateTemplateReferences(banks: readonly BankConfig[], config: ParserConfig) {
  for (const bank of banks)
    for (const id of bank.templates ?? [])
      if (!config.templates.some(t => t.id === id))
        throw new Error(`Bank ${bank.id}: unknown template ${id}`);
}
export async function loadParserConfig(
  path: string,
  banks: readonly BankConfig[],
): Promise<ParserConfig> {
  const config = compileParserConfig(YAML.parse(await readFile(path, 'utf8')));
  validateTemplateReferences(banks, config);
  return config;
}
