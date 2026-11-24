import type {
  ActualAdapter,
  AiSuggestion,
  HistoricalTransaction,
  ResolvedConfig,
} from './types.js';
import { EventStore } from './db.js';
import type { MerchantAssignment } from './merchant-assignments.js';
import { resolveAccount } from './routing.js';

import { merchantKey } from './merchant-key.js';
export { merchantKey } from './merchant-key.js';

export class MerchantResolver {
  private refreshing?: Promise<void>;

  constructor(
    private store: EventStore,
    private actual: ActualAdapter,
    private config: ResolvedConfig,
    private minConfidence: number,
  ) {}

  lookup(accountId: string, merchant: string): MerchantAssignment | undefined {
    return this.store.merchantAssignments.get(accountId, merchantKey(merchant));
  }

  canApply(assignment: MerchantAssignment) {
    if (assignment.status !== 'approved') return false;
    return (
      this.config.expenseCategories?.some(category => category.id === assignment.categoryId) ?? true
    );
  }

  canReplaceHistory(assignment: MerchantAssignment) {
    return !assignment.managed && !this.canApply(assignment);
  }

  learnLocal(
    accountId: string,
    merchant: string,
    suggestion: AiSuggestion,
    eventId: string,
    decisionAt = new Date().toISOString(),
  ) {
    this.store.putLocalMapping({
      account_id: accountId,
      merchant_key: merchantKey(merchant),
      payee: suggestion.payee,
      category_id: suggestion.categoryId,
      source_ref: eventId,
      decision_at: decisionAt,
    });
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.performRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async performRefresh() {
    await this.actual.sync();
    const categories = await this.actual.categories();
    const active = categories.filter(category => !category.isIncome && !category.hidden);
    const activeCategoryIds = new Set(active.map(category => category.id));
    this.config.expenseCategories = active.map(({ id, name }) => ({ id, name }));
    this.seedLocalMappings();
    const accountIds = [...new Set(this.config.accounts.map(account => account.id))];
    const end = new Date().toISOString().slice(0, 10);
    const histories = await Promise.all(
      accountIds.map(accountId => this.actual.transactions(accountId, '1900-01-01', end)),
    );
    const observations = histories
      .flat()
      .map(transaction => this.observation(transaction, activeCategoryIds))
      .filter(observation => observation !== undefined);
    this.store.replaceActualMappings(observations, new Date().toISOString());
  }

  private observation(transaction: HistoricalTransaction, activeCategoryIds: Set<string>) {
    if (
      !transaction.categoryId ||
      !activeCategoryIds.has(transaction.categoryId) ||
      transaction.transferId
    )
      return undefined;
    const description = transaction.importedPayee || transaction.payeeName;
    if (!description) return undefined;
    return {
      actualTransactionId: transaction.id,
      accountId: transaction.accountId,
      merchantKey: merchantKey(description),
      payee: transaction.payeeName || description,
      categoryId: transaction.categoryId,
      transactionDate: transaction.date,
    };
  }

  private seedLocalMappings() {
    const rows = this.store.db
      .prepare(
        "SELECT id,parsed,suggestion,updated_at FROM events WHERE parsed IS NOT NULL AND suggestion IS NOT NULL AND status IN ('imported','imported_review')",
      )
      .all() as { id: string; parsed: string; suggestion: string; updated_at: string }[];
    for (const row of rows) {
      const transaction = JSON.parse(row.parsed);
      const suggestion = JSON.parse(row.suggestion) as AiSuggestion;
      if (suggestion.confidence < this.minConfidence) continue;
      const account = resolveAccount(this.config.accounts, transaction);
      if (account)
        this.learnLocal(account.id, transaction.payee, suggestion, row.id, row.updated_at);
    }
  }
}
