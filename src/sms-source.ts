import type { Bank, BankConfig } from './types.js';
import { normalizeSender } from './config.js';

export type SmsSourceResolution =
  | { type: 'supported'; bank: Bank }
  | { type: 'unsupported'; disposition: 'ignored' | 'needs_review' };

function containsAlias(text: string, alias: string): boolean {
  const escaped = normalizeSender(alias).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(text);
}

/** A named sender is authoritative; message aliases support legacy callers only. */
export function resolveSmsSource(
  sender: string,
  message: string,
  banks: readonly BankConfig[],
): SmsSourceResolution {
  const normalizedSender = normalizeSender(sender);
  const matches = banks.filter(bank =>
    normalizedSender
      ? bank.senders.some(alias => normalizeSender(alias) === normalizedSender)
      : bank.messageAliases.some(alias => containsAlias(normalizeSender(message), alias)),
  );
  // Ambiguous legacy message aliases must never select a bank by rule order.
  if (matches.length > 1) return { type: 'unsupported', disposition: 'needs_review' };
  const bank = matches[0];
  if (!bank) return { type: 'unsupported', disposition: 'ignored' };
  return bank.disposition === 'needs_review'
    ? { type: 'unsupported', disposition: 'needs_review' }
    : { type: 'supported', bank: bank.id };
}
