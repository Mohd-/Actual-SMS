import type { BankConfig, ParsedTransaction, TxKind } from './types.js';
import {
  amountLabels,
  fieldLabels,
  ignoredNotificationRules,
  transactionKindRules,
  type PatternRule,
} from './parsing/grammar.js';
import {
  extractAccountAlias,
  extractAccountAliases,
  extractAmount,
  extractBiller,
  extractDate,
  extractDisplayName,
  extractForeignAmount,
  extractLabelledValue,
  extractMerchant,
  extractNumericReference,
  extractSarEquivalent,
  normalizeText,
} from './parsing/extractors.js';
import { resolveSmsSource } from './sms-source.js';

export { normalizeText } from './parsing/extractors.js';

/** Increment when a parser release should re-evaluate retained parser outcomes. */
export const PARSER_REVISION = 15;

export type ParserReason =
  | 'otp_or_login'
  | 'declined_or_insufficient_funds'
  | 'duplicate_fee_notification'
  | 'unsupported_sender'
  | 'unrecognized_template'
  | 'malformed_notification';

export type ParseResult =
  | { type: 'transaction'; transaction: ParsedTransaction }
  | { type: 'ignored'; reason: ParserReason }
  | { type: 'needs_review'; reason: ParserReason };

function matches(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function classify<T>(text: string, rules: readonly PatternRule<T>[]): T | undefined {
  return rules.find(rule => matches(text, rule.patterns))?.value;
}

function accountReferences(text: string, kind: TxKind) {
  const fromValue = extractLabelledValue(text, fieldLabels.from);
  const toValue = extractLabelledValue(text, fieldLabels.to);
  const ibanValue = extractLabelledValue(text, fieldLabels.iban);
  const genericAlias = extractAccountAlias(text);
  const aliases = extractAccountAliases(text);
  const outgoing = kind === 'transfer_out' || kind === 'card_payment';
  const incoming = kind === 'transfer_in';
  const sourceAccountAlias = extractNumericReference(fromValue);
  const destinationAccountAlias = extractNumericReference(toValue);
  const accountAlias = outgoing
    ? (sourceAccountAlias ?? genericAlias)
    : incoming
      ? (destinationAccountAlias ?? genericAlias)
      : (sourceAccountAlias ?? genericAlias);

  // An explicit IBAN is a routing identifier, never a beneficiary name.
  const transferCounterpartyAlias = outgoing
    ? (extractNumericReference(ibanValue) ??
      destinationAccountAlias ??
      aliases.find(alias => alias !== accountAlias))
    : incoming
      ? sourceAccountAlias
      : undefined;

  return {
    accountAlias,
    transferCounterpartyAlias,
    beneficiaryValue: extractLabelledValue(text, fieldLabels.beneficiary),
    fromValue,
    toValue,
    outgoing,
    incoming,
  };
}

export function parseSms(
  raw: string,
  receivedAt: string,
  banks: readonly BankConfig[],
  sender = '',
): ParseResult {
  const text = normalizeText(raw);
  const ignoredReason = classify(text, ignoredNotificationRules);
  if (ignoredReason) return { type: 'ignored', reason: ignoredReason };

  const source = resolveSmsSource(sender, text, banks);
  if (source.type === 'unsupported')
    return { type: source.disposition, reason: 'unsupported_sender' };
  const { bank } = source;

  const kind = classify(text, transactionKindRules);
  if (!kind) return { type: 'needs_review', reason: 'unrecognized_template' };

  const biller = extractBiller(text);
  const references = accountReferences(text, kind);
  const total = extractAmount(text, amountLabels.total);
  const principal = extractAmount(text, amountLabels.principal) ?? extractSarEquivalent(text);
  const fee = extractAmount(text, amountLabels.fee) ?? 0;
  const foreign = extractForeignAmount(text);
  const sar = total ?? (principal === undefined ? undefined : principal + fee);
  if (sar === undefined && !foreign)
    return { type: 'needs_review', reason: 'malformed_notification' };

  const positive = kind === 'refund' || references.incoming;
  const merchant =
    kind.includes('transfer') || kind === 'card_payment'
      ? undefined
      : (biller.name ?? extractMerchant(text));
  const transferName =
    kind.includes('transfer') || kind === 'card_payment'
      ? (extractDisplayName(references.beneficiaryValue) ??
        extractDisplayName(references.outgoing ? references.toValue : references.fromValue))
      : undefined;
  const payee =
    merchant ??
    transferName ??
    (kind.includes('transfer') || kind === 'card_payment'
      ? 'Bank transfer'
      : kind === 'refund' && /\bcashback\s+of\b/iu.test(text)
        ? 'Card cashback'
        : kind === 'withdrawal'
          ? 'ATM withdrawal'
          : 'Unknown merchant');
  const balance = extractAmount(text, amountLabels.balance);

  return {
    type: 'transaction',
    transaction: {
      bank,
      kind,
      accountAlias: references.accountAlias,
      amountCents: sar === undefined ? null : positive ? sar : -sar,
      principalCents: principal === undefined ? undefined : positive ? principal : -principal,
      feeCents: fee,
      payee,
      occurredAt: extractDate(text, receivedAt),
      balanceCents: balance,
      foreign,
      note: `Parsed ${bank} ${kind}`,
      transferCounterpartyAlias: references.transferCounterpartyAlias,
      billPaymentIdentifier: biller.identifier,
    },
  };
}
