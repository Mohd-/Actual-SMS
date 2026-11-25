import { DateTime } from 'luxon';
import type {
  ActualAdapter,
  ActualTransaction,
  ParsedTransaction,
  ResolvedConfig,
  SmsInput,
} from './types.js';
import { EventStore, type StoredEvent, type ImportExecution } from './db.js';
import { PARSER_REVISION, parseSms } from './parser.js';
import { resolveAccount, resolveBillPaymentAccount, resolveTransferAccount } from './routing.js';
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
  constructor(
    private store: EventStore,
    private actual: ActualAdapter,
    private config: ResolvedConfig,
    private maxAttempts = 5,
    private gate = new WorkGate(),
  ) {}
  private refreshingPayees?: Promise<void>;
  async refreshPayees() {
    this.refreshingPayees ??= this.refreshPayeeCatalog().finally(() => {
      this.refreshingPayees = undefined;
    });
    return this.refreshingPayees;
  }
  private async refreshPayeeCatalog() {
    const release = this.gate.enter();
    if (!release) return;
    try {
      await this.actual.sync();
      const [payees, tags, allCategories] = await Promise.all([
        this.actual.payees(),
        this.actual.tags(),
        this.actual.categories(),
      ]);
      const categories = allCategories
        .filter(category => !category.isIncome && !category.hidden)
        .map(({ id, name, groupName }) => ({ id, name, groupName }));
      const history = this.store.payees.migrationPending
        ? (
            await Promise.all(
              [...new Set(this.config.accounts.map(account => account.id))].map(id =>
                this.actual.transactions(id, '1900-01-01', '9999-12-31'),
              ),
            )
          ).flat()
        : [];
      this.store.payees.refresh({ payees, categories, tags }, history);
      this.config.expenseCategories = categories;
      const allowedNames = this.config.aiCategoryNames;
      const candidates = categories.filter(
        category => category.id !== this.config.bankFeesCategoryId,
      );
      this.config.eligibleCategories = allowedNames
        ? [...new Set(allowedNames)].flatMap(name => {
            const matches = candidates.filter(category => category.name === name);
            return matches.length === 1 ? matches : [];
          })
        : candidates;
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
    if (this.running || this.stopped || this.store.payees.migrationPending) return;
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
      let addedMain: string | undefined;
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
        // A reconciled row may retain the existing payee from a different transaction.
        if (part === 'main') addedMain = result.added[0];
      }
      await this.actual.sync();
      this.store.completeImport(event.id, plan);
      if (
        addedMain &&
        plan.main &&
        !plan.main.preservePendingAssignment &&
        plan.parsed.kind !== 'withdrawal'
      ) {
        await this.observeImportedPayee(plan.accountId, plan.main, addedMain).catch(() => {
          console.warn('Could not verify Actual payee for alias discovery');
        });
      }
    } else this.store.update(event.id, plan.review ? 'imported_review' : 'imported');
  }
  private async observeImportedPayee(accountId: string, main: ActualTransaction, actualId: string) {
    if (!main.imported_payee || !this.store.payees.shouldObserveActual(main.imported_payee)) return;
    const payee = await this.actual.importedTransactionPayee(accountId, actualId, main.imported_id);
    if (payee) this.store.payees.observeActual(main.imported_payee, payee);
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
      const planned = this.store.beginImport(event.id, () => {
        const defaults =
          tx.kind === 'withdrawal'
            ? undefined
            : this.store.payees.defaults(tx.payee, this.config.expenseCategories);
        if (defaults?.categoryId || defaults?.tags.length) {
          this.store.recordEnrichment(event.id, 'payee_defaults_submitted', {
            payee: defaults.name,
            payeeId: defaults.payeeId,
            categoryId: defaults.categoryId,
            tags: defaults.tags,
          });
        }
        const taggedNotes = defaults?.tags.length ? appendTags(notes, defaults.tags) : notes;
        return {
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
            ...(defaults?.payeeId
              ? { payee: defaults.payeeId }
              : { payee_name: defaults?.name ?? tx.payee }),
            imported_payee: tx.payee,
            category: defaults?.categoryId,
            notes: taggedNotes,
            imported_id: id(),
          },
        };
      });
      return this.resumeImport(event, planned);
    }
  }
}

function appendTags(notes: string, tags: string[]) {
  const existing = new Set([...notes.matchAll(/(?:^|[^#])#([^#\s]+)/gu)].map(match => match[1]));
  return [notes, ...tags.filter(tag => !existing.has(tag)).map(tag => `#${tag}`)]
    .filter(Boolean)
    .join(' ');
}
