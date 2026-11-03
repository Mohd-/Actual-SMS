import { DateTime } from 'luxon';
import type { CompiledFields, Field } from './config.js';
const arabicDigits = '٠١٢٣٤٥٦٧٨٩';

export function normalizeText(value: string): string {
  return value
    .replace(/[٠-٩]/g, digit => String(arabicDigits.indexOf(digit)))
    .replace(/\u066b/g, '.')
    .replace(/[\u066c,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function money(value?: string): number | undefined {
  if (!value) return;
  const number = Number(normalizeText(value));
  return Number.isFinite(number) ? Math.round(number * 100) : undefined;
}

export function extractNumericReference(value?: string): string | undefined {
  if (!value) return;
  const text = normalizeText(value);
  const iban = text.match(/\bSA\d{2}(?:\s*\d){20}(?!\d)/iu)?.[0];
  if (iban) return iban.replace(/\s/gu, '').slice(-4);
  const digits = text.match(/\d{3,}/u)?.[0];
  if (!digits) return;
  return digits.length <= 6 ? digits : digits.slice(-4);
}

export function extractDisplayName(value?: string): string | undefined {
  if (!value) return;
  const name = value
    .replace(/\bSA\d{2}[A-Z0-9]{8,}\b/giu, '')
    .replace(/(?:\*|x)+\d+/giu, '')
    .replace(/\d+/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/^[-:–— ]+|[-:–— ]+$/gu, '')
    .trim();
  if (/^(?:account|acct|a\/c|card|حساب|الحساب|بطاقة)$/iu.test(name)) return;
  return /[A-Za-z\u0600-\u06ff]/u.test(name) ? name : undefined;
}

function decodeDate(text: string, receivedAt: string): string {
  const iso = text.match(/(20\d\d[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)/)?.[1];
  if (iso) {
    const normalized = iso.replaceAll('/', '-').replace('T', ' ');
    const format = iso.includes(':')
      ? iso.match(/:\d{2}:\d{2}$/u)
        ? 'yyyy-M-d H:mm:ss'
        : 'yyyy-M-d H:mm'
      : 'yyyy-M-d';
    const date = DateTime.fromFormat(normalized, format, { zone: 'Asia/Riyadh' });
    if (date.isValid) return date.toISO()!;
  }

  const slash = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+\d{1,2}:\d{2})?)/)?.[1];
  if (slash) {
    const fullYear = slash.split(/\s/u, 1)[0]!.split('/').at(-1)?.length === 4;
    const formats = fullYear
      ? [slash.includes(':') ? 'd/M/yyyy H:mm' : 'd/M/yyyy']
      : slash.includes(':')
        ? ['d/M/yy H:mm', 'yy/M/d H:mm']
        : ['d/M/yy', 'yy/M/d'];
    const received = DateTime.fromISO(receivedAt).setZone('Asia/Riyadh');
    const closest = formats
      .map(format => DateTime.fromFormat(slash, format, { zone: 'Asia/Riyadh' }))
      .filter(date => date.isValid)
      .sort(
        (left, right) =>
          Math.abs(left.toMillis() - received.toMillis()) -
          Math.abs(right.toMillis() - received.toMillis()),
      )[0];
    if (closest) return closest.toISO()!;
  }

  return DateTime.fromISO(receivedAt).setZone('Asia/Riyadh').toISO()!;
}

export function createExtractors(fields: CompiledFields) {
  const groups = (text: string, field: Field) => {
    for (const pattern of fields[field] ?? []) {
      const match = pattern.exec(text);
      if (match) return match.groups;
    }
  };
  const value = (text: string, field: Field) => groups(text, field)?.value?.trim();
  return {
    value,
    extractAmount: (text: string, field: Field) => money(value(text, field)),
    extractSarEquivalent: (text: string) => money(value(text, 'sarEquivalent')),
    extractAccountAlias: (text: string) => value(text, 'accountAlias'),
    extractAccountAliases: (text: string) =>
      (fields.accountAliases ?? []).flatMap(pattern =>
        [...text.matchAll(new RegExp(pattern.source, pattern.flags + 'g'))].flatMap(match =>
          match.groups?.value ? [match.groups.value.trim()] : [],
        ),
      ),
    extractLabelledValue: value,
    extractBiller: (text: string) => ({
      identifier: extractNumericReference(value(text, 'biller')),
      name: extractDisplayName(value(text, 'biller')),
    }),
    isValidDate: (text: string) => decodeDate(value(text, 'date') ?? '', 'invalid') != null,
    extractDate: (text: string, receivedAt: string) =>
      decodeDate(value(text, 'date') ?? '', receivedAt),
    extractForeignAmount: (text: string) => {
      const match = groups(text, 'foreign');
      if (!match) return;
      const rawAmount = match.amount ?? match.trailingAmount;
      if (!rawAmount?.trim()) return;
      const amount = Number(rawAmount);
      const currency = match.currency ?? match.trailingCurrency;
      return Number.isFinite(amount) && currency
        ? { amount, currency: currency.toUpperCase() }
        : undefined;
    },
    extractMerchant: (text: string) => value(text, 'merchant'),
    isCashback: (text: string) => (fields.cashback ?? []).some(p => p.test(text)),
  };
}
