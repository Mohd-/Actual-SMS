import { DateTime } from 'luxon';
import {
  accountAliasPatterns,
  allAccountAliasesPattern,
  dateValue,
  fieldDelimiter,
  foreignAmountPattern,
  foreignCurrency,
  isoDatePattern,
  labelledFieldStops,
  merchantPatterns,
  slashDatePattern,
} from './grammar.js';

const arabicDigits = '٠١٢٣٤٥٦٧٨٩';

export function normalizeText(value: string): string {
  return value
    .replace(/[٠-٩]/g, digit => String(arabicDigits.indexOf(digit)))
    .replace(/\u066b/g, '.')
    .replace(/[\u066c,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function capture(text: string, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1].trim();
  }
}

function money(value?: string): number | undefined {
  if (!value) return;
  const number = Number(normalizeText(value));
  return Number.isFinite(number) ? Math.round(number * 100) : undefined;
}

export function extractAmount(text: string, labels: readonly string[]): number | undefined {
  for (const label of labels) {
    const guardedLabel =
      label === 'amount'
        ? '(?<!total\\s)(?<!due\\s)(?<!purchase\\s)(?<!transfer\\s)amount(?:\\s+of)?'
        : label === 'amount in (?:SAR|SR)'
          ? `(?<!total\\s)${label}`
          : label === 'مبلغ'
            ? '(?<![\\p{L}])مبلغ'
            : label === 'المبلغ'
              ? '(?<!اجمالي\\s)المبلغ'
              : label;
    const value = capture(text, [
      new RegExp(
        `${guardedLabel}\\s*[:：]?\\s*(?:\\(\\d+\\)\\s*)?(?:SAR|SR|ر\\.?س\\.?)?\\s*([\\d,.٠-٩]+)(?![\\d,.٠-٩])(?!(?:\\s*${foreignCurrency}\\b))`,
        'iu',
      ),
      new RegExp(`(?:SAR|SR|ر\\.?س\\.?)\\s*([\\d,.٠-٩]+)\\s*${guardedLabel}`, 'iu'),
    ]);
    if (value) return money(value);
  }
}

/** SAR equivalent shown in parentheses immediately after a foreign amount. */
export function extractSarEquivalent(text: string): number | undefined {
  const value = capture(text, [
    new RegExp(
      `(?:${foreignCurrency}\\s*[\\d,.]+|[\\d,.]+\\s*${foreignCurrency})\\s*\\(\\s*(?:SAR|SR)\\s*([\\d,.]+)\\s*\\)`,
      'iu',
    ),
    new RegExp(
      `(?:${foreignCurrency}\\s*[\\d,.]+|[\\d,.]+\\s*${foreignCurrency})\\s*\\(\\s*([\\d,.]+)\\s*(?:SAR|SR)\\s*\\)`,
      'iu',
    ),
  ]);
  return money(value);
}

export function extractAccountAlias(text: string): string | undefined {
  return capture(text, accountAliasPatterns)?.replace(/[٠-٩]/g, digit =>
    String(arabicDigits.indexOf(digit)),
  );
}

/** Account and card suffixes, retained in their SMS appearance order. */
export function extractAccountAliases(text: string): string[] {
  return [...text.matchAll(allAccountAliasesPattern)].map(match => normalizeText(match[1]!));
}

/** Extract a labelled value without relying on the order of other fields. */
export function extractLabelledValue(text: string, labels: string): string | undefined {
  return capture(text, [
    new RegExp(
      `(?:^|\\s)${labels}(?=\\s|${fieldDelimiter}|$)\\s*${fieldDelimiter}?\\s*(.{1,100}?)(?=\\s+(?:${labelledFieldStops})(?=\\s|${fieldDelimiter}|$)\\s*${fieldDelimiter}?|\\s+(?:on|at|في|بتاريخ)\\s*${fieldDelimiter}?\\s*${dateValue}|[;,؛]|$)`,
      'iu',
    ),
  ]);
}

export function extractNumericReference(value?: string): string | undefined {
  if (!value) return;
  const digits = normalizeText(value).match(/\d{3,}/u)?.[0];
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

export function extractBiller(text: string): { identifier?: string; name?: string } {
  const value = extractLabelledValue(text, '(?:biller|مفوتر)');
  return {
    identifier: extractNumericReference(value),
    name: extractDisplayName(value),
  };
}

export function extractDate(text: string, receivedAt: string): string {
  const iso = capture(text, [isoDatePattern]);
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

  const slash = capture(text, [slashDatePattern]);
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

export function extractForeignAmount(
  text: string,
): { currency: string; amount: number } | undefined {
  const match = foreignAmountPattern.exec(text);
  if (!match) return;
  return {
    currency: (match[3] ?? match[0].slice(0, 3)).toUpperCase(),
    amount: Number(match[1] ?? match[2]),
  };
}

export function extractMerchant(text: string): string | undefined {
  return capture(text, merchantPatterns);
}
