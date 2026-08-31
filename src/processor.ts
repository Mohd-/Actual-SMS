import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type {
  ActualAdapter,
  Enricher,
  ParsedTransaction,
  ResolvedConfig,
  SmsInput,
  AiSuggestion,
} from './types.js';
import { EventStore, type StoredEvent } from './db.js';
import { PARSER_REVISION, parseSms } from './parser.js';
import { resolveAccount, resolveBillPaymentAccount, resolveTransferAccount } from './routing.js';
import { MerchantResolver, merchantKey } from './merchant-resolver.js';

const retryMs = [60_000, 300_000, 1_800_000, 7_200_000];
// Historical imports used the parsed SMS suffix. Keep that stable whenever a
// source identifier was present, only falling back to the resolved account.
const stableId = (tx: ParsedTransaction, accountKey: string, suffix = 'main') =>
  'sms:' +
  createHash('sha256')
    .update(
      [
        tx.bank,
        tx.accountAlias ?? accountKey,
        tx.kind,
        tx.occurredAt,
        tx.amountCents,
        tx.payee,
        suffix,
      ].join('|'),
    )
    .digest('hex');
export class Processor {
  private timer?: NodeJS.Timeout;
  private running = false;
  private merchantResolver: MerchantResolver;
  constructor(
    private store: EventStore,
    private actual: ActualAdapter,
    private ai: Enricher,
    private config: ResolvedConfig,
    private maxAttempts = 5,
    private minConfidence = 0.7,
    merchantResolver?: MerchantResolver,
  ) {
    this.merchantResolver =
      merchantResolver ?? new MerchantResolver(store, actual, config, minConfidence);
  }
  refreshMappings() {
    return this.merchantResolver.refresh();
  }
  start() {
    this.store.recover();
    this.store.replayParserRevision(PARSER_REVISION);
    this.timer = setInterval(() => void this.tick(), 500);
    void this.tick();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise(r => setTimeout(r, 20));
  }
  async tick() {
    if (this.running) return;
    const event = this.store.claim();
    if (!event) return;
    this.running = true;
    try {
      await this.process(event);
    } catch (error) {
      const attempts = event.attempts + 1,
        message = error instanceof Error ? error.message : String(error);
      if (attempts < this.maxAttempts)
        this.store.update(event.id, 'queued', {
          attempts,
          error: message,
          nextAttemptAt: new Date(
            Date.now() + (retryMs[attempts - 1] ?? retryMs.at(-1)!),
          ).toISOString(),
        });
      else this.store.update(event.id, 'failed', { attempts, error: message });
    } finally {
      this.running = false;
    }
  }
  private async process(event: StoredEvent) {
    const input = JSON.parse(event.payload!) as SmsInput;
    const result = parseSms(input.message, input.receivedAt, input.sender);
    if (result.type === 'ignored' || result.type === 'needs_review') {
      this.store.recordEnrichment(event.id, 'not_applicable', {
        reason: result.type,
        parserReason: result.reason,
      });
      this.store.update(event.id, result.type, {
        parserReason: result.reason,
        parserRevision: PARSER_REVISION,
      });
      return;
    }
    const tx = result.transaction;
    const account = resolveAccount(this.config.accounts, tx);
    if (!account)
      throw new Error(
        `Unmapped account route: ${tx.bank}${tx.accountAlias ? ` suffix ${tx.accountAlias}` : ''}`,
      );
    let review = false;
    if (tx.balanceCents !== undefined) {
      if (tx.amountCents === null && tx.foreign) {
        const previous = this.store.previousBalance(account.key, tx.occurredAt);
        if (previous !== undefined) {
          const delta = tx.balanceCents - previous;
          const positive = tx.kind === 'refund' || tx.kind === 'transfer_in';
          if (delta !== 0 && delta > 0 === positive) tx.amountCents = delta;
          else review = true;
        } else review = true;
      }
      this.store.addBalance(account.key, tx.occurredAt, tx.balanceCents, event.id);
    }
    if (tx.amountCents === null) {
      tx.amountCents = 0;
      review = true;
    }
    this.store.update(event.id, 'processing', { parsed: tx, parserRevision: PARSER_REVISION });
    const isTransfer = ['transfer_in', 'transfer_out', 'card_payment'].includes(tx.kind);
    let suggestion: AiSuggestion | null = null;
    let selectedPayee = tx.payee;
    let selectedCategory: string | undefined;
    if (!isTransfer && tx.kind !== 'withdrawal') {
      const mapping = this.merchantResolver.lookup(account.id, tx.payee);
      if (mapping) {
        selectedPayee = mapping.payee;
        selectedCategory = mapping.category_id;
        this.store.recordEnrichment(event.id, 'history_hit', {
          merchant: tx.payee,
          merchantKey: mapping.merchant_key,
          accountId: account.id,
          payee: mapping.payee,
          categoryId: mapping.category_id,
          source: mapping.source,
          sourceRef: mapping.source_ref,
          decisionAt: mapping.decision_at,
        });
      } else {
        const request = {
          merchant: tx.payee,
          location: input.location,
          occurredAt: tx.occurredAt,
          categories: this.config.eligibleCategories,
        };
        this.store.recordEnrichment(event.id, 'history_miss', {
          merchant: tx.payee,
          merchantKey: merchantKey(tx.payee),
          accountId: account.id,
        });
        const started = Date.now();
        const enrichment = await this.ai.enrich(request).catch(error => ({
          status: 'network_error' as const,
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        }));
        if (enrichment.status === 'success') {
          suggestion = enrichment.suggestion;
          selectedPayee = suggestion.payee;
          const applied = suggestion.confidence >= this.minConfidence;
          if (applied) {
            selectedCategory = suggestion.categoryId;
            this.merchantResolver.learnLocal(account.id, tx.payee, suggestion, event.id);
          }
          this.store.update(event.id, 'processing', { suggestion });
          this.store.recordEnrichment(event.id, applied ? 'llm_success' : 'llm_low_confidence', {
            request,
            result: bounded(enrichment),
            threshold: this.minConfidence,
            payeeApplied: true,
            categoryApplied: applied,
          });
        } else {
          this.store.recordEnrichment(event.id, `llm_${enrichment.status}`, {
            request,
            result: bounded(enrichment),
            threshold: this.minConfidence,
          });
        }
      }
    } else {
      this.store.recordEnrichment(event.id, 'not_applicable', {
        reason: isTransfer ? 'transfer' : 'withdrawal',
        kind: tx.kind,
      });
    }
    const date = DateTime.fromISO(tx.occurredAt).toISODate()!;
    const notes = [
      tx.note,
      tx.foreign ? `${tx.foreign.amount} ${tx.foreign.currency}` : '',
      review ? 'REVIEW REQUIRED' : '',
    ]
      .filter(Boolean)
      .join(' | ');
    if (isTransfer) {
      const counterpart = this.store.findTransferCounterpart(
        event.id,
        account.key,
        tx.principalCents ?? tx.amountCents,
        tx.occurredAt,
      );
      if (counterpart) {
        this.store.recordTransfer(
          event.id,
          account.key,
          tx.transferCounterpartyAlias,
          tx.principalCents ?? tx.amountCents,
          tx.occurredAt,
          counterpart.event_id,
        );
        this.store.update(event.id, 'imported');
        return;
      }
      const target = tx.billPaymentIdentifier
        ? resolveBillPaymentAccount(this.config.accounts, tx.billPaymentIdentifier)
        : tx.transferCounterpartyAlias
          ? resolveTransferAccount(this.config.accounts, tx.transferCounterpartyAlias)
          : undefined;
      if (target) {
        const payee = await this.actual.transferPayee(target.id);
        const principal =
          tx.principalCents ?? (tx.amountCents < 0 ? tx.amountCents + tx.feeCents : tx.amountCents);
        await this.actual.importTransactions(account.id, [
          {
            date,
            amount: principal,
            payee,
            notes,
            imported_id: stableId(tx, account.key, 'principal'),
          },
        ]);
        if (tx.feeCents)
          await this.actual.importTransactions(account.id, [
            {
              date,
              amount: -tx.feeCents,
              payee_name: 'Bank Fees',
              category: this.config.bankFeesCategoryId,
              notes,
              imported_id: stableId(tx, account.key, 'fee'),
            },
          ]);
        this.store.recordTransfer(
          event.id,
          account.key,
          tx.transferCounterpartyAlias,
          principal,
          tx.occurredAt,
        );
      } else
        await this.actual.importTransactions(account.id, [
          {
            date,
            amount: tx.amountCents,
            payee_name: tx.payee,
            notes,
            imported_id: stableId(tx, account.key),
          },
        ]);
    } else {
      const imported = await this.actual.importTransactions(account.id, [
        {
          date,
          amount: tx.amountCents,
          payee_name: selectedPayee,
          imported_payee: tx.payee,
          category: selectedCategory,
          notes,
          imported_id: stableId(tx, account.key),
        },
      ]);
      if (imported.errors.length)
        throw new Error(imported.errors.map(error => error.message).join('; '));
      const actualTransactionId = imported.added[0] ?? imported.updated[0];
      if (actualTransactionId) this.store.update(event.id, 'processing', { actualTransactionId });
    }
    await this.actual.sync();
    this.store.update(event.id, review ? 'imported_review' : 'imported');
  }
}

function bounded(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  return serialized.length <= 65_536
    ? value
    : { truncated: true, value: serialized.slice(0, 65_536) };
}
