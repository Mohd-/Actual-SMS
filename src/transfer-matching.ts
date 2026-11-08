import type { ImportPlan, ParsedTransaction, ResolvedAccount } from './types.js';
import { resolveAccount, resolveBillPaymentAccount, resolveTransferAccount } from './routing.js';

export interface TransferCandidate {
  eventId: string;
  prior: ParsedTransaction;
  plan: ImportPlan | null;
}
export type TransferRecognition =
  | { type: 'unrelated' }
  | { type: 'hold'; reason: string }
  | {
      type: 'matched';
      candidate: TransferCandidate;
      account?: ResolvedAccount;
      coversPrincipal: boolean;
    };

/** Candidates have already passed the opposite-principal and 15-minute filters.
 * Amount/time alone never authorizes pairing or a replacement principal write.
 */
export function recognizeTransfer(
  tx: ParsedTransaction,
  candidates: TransferCandidate[],
): TransferRecognition {
  const matches: Extract<TransferRecognition, { type: 'matched' }>[] = [];
  let uncertain = false;
  for (const candidate of candidates) {
    const { prior, plan } = candidate;
    if (plan && plan.version !== 1) {
      uncertain = true;
      continue;
    }
    const source = plan?.endpoints?.source;
    const target = plan?.endpoints?.target;
    const rawOwn =
      tx.accountAlias !== undefined && tx.accountAlias === prior.transferCounterpartyAlias;
    const rawOther =
      prior.accountAlias !== undefined && tx.transferCounterpartyAlias === prior.accountAlias;
    const own = target && resolveAccount([target], tx);
    const other =
      source &&
      (tx.billPaymentIdentifier
        ? resolveBillPaymentAccount([source], tx.billPaymentIdentifier)
        : tx.transferCounterpartyAlias
          ? resolveTransferAccount([source], tx.transferCounterpartyAlias)
          : undefined);
    const related = own || other || rawOwn || rawOther;
    if (!related) {
      if (!source) {
        // A legacy record has no endpoint snapshot. Only explicit, different
        // identifiers at both ends establish that it is unrelated.
        const differentOwn = tx.accountAlias && prior.transferCounterpartyAlias && !rawOwn;
        const differentOther = tx.transferCounterpartyAlias && prior.accountAlias && !rawOther;
        if (!differentOwn || !differentOther) uncertain = true;
      } else if (target && tx.bank === target.match.bank && !tx.accountAlias) uncertain = true;
      continue;
    }
    const targetIdentifiers = [
      ...(target?.match.accountSuffixes ?? []),
      ...(target?.match.transferIdentifiers ?? []),
    ];
    // A broad bank/balance route cannot override an explicitly different recipient.
    // Biller codes identify a destination but are not the card's own SMS suffix.
    const knownRecipient = prior.billPaymentIdentifier
      ? undefined
      : prior.transferCounterpartyAlias;
    const conflictingOwn =
      target &&
      (tx.bank !== target.match.bank ||
        (tx.accountAlias !== undefined &&
          (knownRecipient || targetIdentifiers.length > 0) &&
          !rawOwn &&
          !targetIdentifiers.includes(tx.accountAlias)));
    const conflictingOther =
      source &&
      !other &&
      !rawOther &&
      (tx.billPaymentIdentifier || tx.transferCounterpartyAlias) &&
      (source.match.accountSuffixes ||
        source.match.transferIdentifiers ||
        source.match.billPaymentIdentifiers ||
        prior.accountAlias);
    if (!source || (plan?.targetKey && !target) || conflictingOwn || conflictingOther) {
      uncertain = true;
      continue;
    }
    matches.push({
      type: 'matched',
      candidate,
      account: target,
      coversPrincipal: Boolean(plan?.targetKey),
    });
  }
  if (uncertain || matches.length > 1)
    return {
      type: 'hold',
      reason:
        'Transfer counterpart evidence is ambiguous or incomplete; operator reconciliation required',
    };
  return matches[0] ?? { type: 'unrelated' };
}
