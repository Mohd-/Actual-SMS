import type { ImportPlan, ParsedTransaction, ResolvedAccount, TransferEndpoint } from './types.js';
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

export function snapshotTransferEndpoint(
  account: ResolvedAccount,
  accounts: ResolvedAccount[],
): TransferEndpoint {
  return structuredClone({
    ...account,
    rules: accounts.filter(rule => rule.key === account.key).map(rule => rule.match),
  });
}

function endpointRules(endpoint: TransferEndpoint | undefined): ResolvedAccount[] {
  return endpoint
    ? (endpoint.rules ?? [endpoint.match]).map(match => ({ ...endpoint, match }))
    : [];
}

function hasCompleteEndpointEvidence(plan: ImportPlan | null): boolean {
  return Boolean(
    plan?.endpoints?.source.rules?.length &&
    (!plan.targetKey || plan.endpoints.target?.rules?.length),
  );
}

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
    const sourceRules = endpointRules(source);
    const targetRules = endpointRules(target);
    const rawOwn =
      tx.accountAlias !== undefined && tx.accountAlias === prior.transferCounterpartyAlias;
    const rawOther =
      prior.accountAlias !== undefined && tx.transferCounterpartyAlias === prior.accountAlias;
    const own = target && resolveAccount(targetRules, tx);
    const other =
      source &&
      (tx.billPaymentIdentifier
        ? resolveBillPaymentAccount(sourceRules, tx.billPaymentIdentifier)
        : tx.transferCounterpartyAlias
          ? resolveTransferAccount(sourceRules, tx.transferCounterpartyAlias)
          : undefined);
    const related = own || other || rawOwn || rawOther;
    if (!related) {
      // A selected legacy rule can prove a match, but cannot exclude aliases
      // omitted from its snapshot. Different raw identifiers are not enough.
      if (
        !hasCompleteEndpointEvidence(plan) ||
        (targetRules.some(rule => tx.bank === rule.match.bank) && !tx.accountAlias)
      )
        uncertain = true;
      continue;
    }
    const targetIdentifiers = targetRules
      .filter(rule => rule.match.bank === tx.bank)
      .flatMap(rule => [
        ...(rule.match.accountSuffixes ?? []),
        ...(rule.match.transferIdentifiers ?? []),
      ]);
    // A broad bank/balance route cannot override an explicitly different recipient.
    // Biller codes identify a destination but are not the card's own SMS suffix.
    const knownRecipient = prior.billPaymentIdentifier
      ? undefined
      : prior.transferCounterpartyAlias;
    const conflictingOwn =
      target &&
      (!targetRules.some(rule => rule.match.bank === tx.bank) ||
        (tx.accountAlias !== undefined &&
          (knownRecipient || targetIdentifiers.length > 0) &&
          !rawOwn &&
          !targetIdentifiers.includes(tx.accountAlias)));
    const conflictingOther =
      source &&
      !other &&
      !rawOther &&
      (tx.billPaymentIdentifier || tx.transferCounterpartyAlias) &&
      (sourceRules.some(
        rule =>
          rule.match.accountSuffixes ||
          rule.match.transferIdentifiers ||
          rule.match.billPaymentIdentifiers,
      ) ||
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
