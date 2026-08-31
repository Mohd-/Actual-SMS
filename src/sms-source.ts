import type { Bank } from './types.js';

export type SmsSourceResolution =
  | { type: 'supported'; bank: Bank }
  | { type: 'unsupported'; disposition: 'ignored' | 'needs_review' };

const senderRules: readonly { bank: Bank; patterns: readonly RegExp[] }[] = [
  {
    bank: 'sab',
    patterns: [/(?:^|\b)(?:sab|saudi\s+awwal)(?:\b|$)|ساب|الأول/iu],
  },
  {
    bank: 'alrajhi',
    patterns: [/(?:al\s*rajhi|alrajhibank|الراجحي)/iu],
  },
];

const messageFallbackRules: readonly { bank: Bank; patterns: readonly RegExp[] }[] = [
  {
    bank: 'sab',
    patterns: [/(?:\b(?:sab|saudi\s+awwal)\b|ساب|الأول)/iu],
  },
  {
    bank: 'alrajhi',
    patterns: [/(?:\bal\s*rajhi\b|الراجحي)/iu],
  },
];

const unsupportedReviewSenderPatterns = [/(?:^|\b)stc\s*bank(?:\b|$)|بنك\s*stc/iu] as const;

function normalizeSourceText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function matches(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function identify(text: string, rules: typeof senderRules): Bank | undefined {
  return rules.find(rule => matches(text, rule.patterns))?.bank;
}

/**
 * Identifies the source independently of the SMS transaction grammar. A named
 * sender is authoritative; message inspection is retained only for callers
 * using the legacy sender-optional contract.
 */
export function resolveSmsSource(sender: string, message: string): SmsSourceResolution {
  if (sender.trim()) {
    const normalizedSender = normalizeSourceText(sender);
    if (matches(normalizedSender, unsupportedReviewSenderPatterns))
      return { type: 'unsupported', disposition: 'needs_review' };
    const bank = identify(normalizedSender, senderRules);
    return bank ? { type: 'supported', bank } : { type: 'unsupported', disposition: 'ignored' };
  }

  const bank = identify(normalizeSourceText(message), messageFallbackRules);
  return bank ? { type: 'supported', bank } : { type: 'unsupported', disposition: 'ignored' };
}
