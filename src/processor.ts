import { DateTime } from 'luxon';
import type {
  ActualAdapter,
  Enricher,
  ParsedTransaction,
  ResolvedConfig,
  SmsInput,
  AiSuggestion,
} from './types.js';
import { EventStore, type StoredEvent, type ImportExecution } from './db.js';
import { PARSER_REVISION, parseSms } from './parser.js';
import { resolveAccount, resolveBillPaymentAccount, resolveTransferAccount } from './routing.js';
import { MerchantResolver, merchantKey } from './merchant-resolver.js';
import { importId } from './import-identity.js';
import { WorkGate } from './work-gate.js';
import {
  recognizeTransfer,
  snapshotTransferEndpoint,
  type TransferRecognition,
} from './transfer-matching.js';

const retryMs = [60_000, 300_000, 1_800_000, 7_200_000];
export class Processor {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private merchantResolver: MerchantResolver;
  constructor(
    private store: EventStore,
    private actual: ActualAdapter,
    private ai: Enricher,
    private config: ResolvedConfig,
    private maxAttempts = 5,
    private minConfidence = 0.7,
    merchantResolver?: MerchantResolver,
    private gate = new WorkGate(),
  ) {
    this.merchantResolver =
      merchantResolver ?? new MerchantResolver(store, actual, config, minConfidence);
  }
  async refreshMappings() {
    const release = this.gate.enter();
    if (!release) return;
    try {
      await this.merchantResolver.refresh();
    } finally {
      release();
    }
  }
  start() {
    this.stopped = false;
    this.store.recover();
    this.store.replayParserRevision(PARSER_REVISION);
    this.timer = setInterval(() => void this.tick(), 500);
    void this.tick();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise(r => setTimeout(r, 20));
  }
  async tick() {
    if (this.running || this.stopped) return;
    const release = this.gate.enter();
    if (!release) return;
    let event: StoredEvent | undefined;
    this.running = true;
    try {
      event = this.store.claim();
      if (!event) return;
      await this.process(event);
    } catch (error) {
      if (!event) throw error;
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
      release();
    }
  }
  private async resumeImport(event: StoredEvent, execution: ImportExecution) {
    const plan = execution.plan;
    if (!plan) {
      this.store.update(event.id, 'failed', {
        error: 'Historical import has uncertain writes; operator reconciliation required',
      });
      return;
    }
    if (plan.version !== 1)
      throw new Error('Unsupported import execution version; reconciliation required');
    if (!execution.complete) {
      for (const part of ['main', 'principal', 'fee'] as const) {
        const transaction = plan[part];
        const done = {
          main: execution.mainDone,
          principal: execution.principalDone,
          fee: execution.feeDone,
        };
        if (!transaction || done[part]) continue;
        const result = await this.actual.importTransactions(plan.accountId, [transaction]);
        this.store.importProgress(
          event.id,
          part,
          result.errors.length === 0,
          result.added[0] ?? result.updated[0],
        );
        if (result.errors.length)
          throw new Error(result.errors.map(error => error.message).join('; '));
      }
      await this.actual.sync();
      this.store.completeImport(event.id, plan);
    } else this.store.update(event.id, plan.review ? 'imported_review' : 'imported');
  }
  private waitForTransfer(event: StoredEvent, ownerId: string) {
    const owner = this.store.get(ownerId)!;
    this.store.update(event.id, owner.status === 'failed' ? 'failed' : 'queued', {
      error: `Transfer counterpart ${owner.id} has not completed; awaiting its import and sync or operator reconciliation`,
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }
  private async process(event: StoredEvent) {
    const execution = this.store.importExecution(event.id);
    if (execution) return this.resumeImport(event, execution);
    const input = JSON.parse(event.payload!) as SmsInput;
    const result = parseSms(
      input.message,
      input.receivedAt,
      this.config.banks,
      input.sender,
      this.config.parsing,
    );
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
    const isTransfer = ['transfer_in', 'transfer_out', 'card_payment'].includes(tx.kind);
    let recognition: TransferRecognition = { type: 'unrelated' };
    if (isTransfer && tx.amountCents !== null) {
      const legacyConflict = this.store.legacyTransferConflict(tx);
      if (legacyConflict) return this.waitForTransfer(event, legacyConflict);
      recognition = recognizeTransfer(
        tx,
        this.store
          .findTransferCounterparts(event.id, tx.principalCents ?? tx.amountCents, tx.occurredAt)
          .map(candidate => {
            const plan = this.store.importExecution(candidate.event_id)?.plan ?? null;
            return {
              eventId: candidate.event_id,
              plan,
              prior:
                plan?.parsed ??
                (JSON.parse(this.store.get(candidate.event_id)!.parsed!) as ParsedTransaction),
            };
          }),
      );
      if (recognition.type === 'hold') {
        this.store.update(event.id, 'failed', {
          parsed: tx,
          parserRevision: PARSER_REVISION,
          error: recognition.reason,
        });
        return;
      }
      if (
        recognition.type === 'matched' &&
        !['imported', 'imported_review'].includes(
          this.store.get(recognition.candidate.eventId)!.status,
        )
      )
        return this.waitForTransfer(event, recognition.candidate.eventId);
    }
    const counterpart = recognition.type === 'matched' ? recognition.candidate : undefined;
    const account =
      (recognition.type === 'matched' ? recognition.account : undefined) ??
      resolveAccount(this.config.accounts, tx);
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
    const date = DateTime.fromISO(tx.occurredAt, { setZone: true }).toISODate()!;
    const notes = [
      tx.note,
      tx.foreign ? `${tx.foreign.amount} ${tx.foreign.currency}` : '',
      review ? 'REVIEW REQUIRED' : '',
    ]
      .filter(Boolean)
      .join(' | ');
    const id = (part = 'main') => importId(this.store, event, tx, account.key, part);
    if (isTransfer) {
      if (recognition.type === 'matched' && recognition.coversPrincipal) {
        const planned = this.store.beginImport(event.id, () => ({
          version: 1,
          kind: 'transfer',
          accountId: account.id,
          sourceKey: account.key,
          targetKey: counterpart!.plan!.sourceKey,
          endpoints: { source: account, target: counterpart!.plan!.endpoints!.source },
          parsed: tx,
          principalCents: tx.principalCents ?? tx.amountCents!,
          fee: tx.feeCents
            ? {
                date,
                amount: -tx.feeCents,
                payee_name: 'Bank Fees',
                category: this.config.bankFeesCategoryId,
                notes,
                imported_id: id('fee'),
              }
            : undefined,
          review,
          matchedEventId: counterpart!.eventId,
        }));
        return this.resumeImport(event, planned);
      }
      // A counterpart already imported without a transfer payee covers only
      // its own account. Import this side independently to avoid crediting
      // that account again through Actual's linked transfer.
      const target = counterpart
        ? undefined
        : tx.billPaymentIdentifier
          ? resolveBillPaymentAccount(this.config.accounts, tx.billPaymentIdentifier)
          : tx.transferCounterpartyAlias
            ? resolveTransferAccount(this.config.accounts, tx.transferCounterpartyAlias)
            : undefined;
      const principal = target
        ? (tx.principalCents ??
          (tx.amountCents < 0 ? tx.amountCents + tx.feeCents : tx.amountCents))
        : tx.amountCents;
      const payee = target ? await this.actual.transferPayee(target.id) : undefined;
      const planned = this.store.beginImport(event.id, () => ({
        version: 1,
        kind: 'transfer',
        accountId: account.id,
        sourceKey: account.key,
        targetKey: target?.key,
        endpoints: {
          source: snapshotTransferEndpoint(account, this.config.accounts),
          target: target ? snapshotTransferEndpoint(target, this.config.accounts) : undefined,
        },
        parsed: tx,
        principalCents: target ? principal : (tx.principalCents ?? tx.amountCents!),
        principal: {
          date,
          amount: principal,
          ...(target ? { payee } : { payee_name: tx.payee }),
          notes,
          imported_id: target ? id('principal') : id(),
        },
        fee:
          target && tx.feeCents
            ? {
                date,
                amount: -tx.feeCents,
                payee_name: 'Bank Fees',
                category: this.config.bankFeesCategoryId,
                notes,
                imported_id: id('fee'),
              }
            : undefined,
        review,
        matchedEventId: counterpart?.eventId,
      }));
      return this.resumeImport(event, planned);
    } else {
      const planned = this.store.beginImport(event.id, () => ({
        version: 1,
        kind: 'ordinary',
        accountId: account.id,
        sourceKey: account.key,
        parsed: tx,
        principalCents: tx.amountCents!,
        review,
        main: {
          date,
          amount: tx.amountCents!,
          payee_name: selectedPayee,
          imported_payee: tx.payee,
          category: selectedCategory,
          notes,
          imported_id: id(),
        },
      }));
      return this.resumeImport(event, planned);
    }
  }
}

function bounded(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  return serialized.length <= 65_536
    ? value
    : { truncated: true, value: serialized.slice(0, 65_536) };
}
