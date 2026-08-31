import type {
  ActualAdapter,
  AiSuggestion,
  HistoricalTransaction,
  ResolvedConfig,
} from './types.js';
import { EventStore, type MerchantMapping } from './db.js';
import { resolveAccount } from './routing.js';

const arabicDigits = '٠١٢٣٤٥٦٧٨٩';

export function merchantKey(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[٠-٩]/gu, digit => String(arabicDigits.indexOf(digit)))
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export class MerchantResolver {
  private activeCategoryIds = new Set<string>();
  private categoriesLoaded = false;
  private refreshing?: Promise<void>;

  constructor(
    private store: EventStore,
    private actual: ActualAdapter,
    private config: ResolvedConfig,
    private minConfidence: number,
  ) {}

  lookup(accountId: string, merchant: string): MerchantMapping | undefined {
    const mapping = this.store.mapping(accountId, merchantKey(merchant));
    return mapping && (!this.categoriesLoaded || this.activeCategoryIds.has(mapping.category_id))
      ? mapping
      : undefined;
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
    this.activeCategoryIds = new Set(
      categories
        .filter(category => !category.isIncome && !category.hidden)
        .map(category => category.id),
    );
    this.categoriesLoaded = true;
    this.seedLocalMappings();
    const accountIds = [...new Set(this.config.accounts.map(account => account.id))];
    const end = new Date().toISOString().slice(0, 10);
    const histories = await Promise.all(
      accountIds.map(accountId => this.actual.transactions(accountId, '1900-01-01', end)),
    );
    const observations = histories
      .flat()
      .map(transaction => this.observation(transaction))
      .filter(observation => observation !== undefined);
    this.store.replaceActualMappings(observations, new Date().toISOString());
  }

  private observation(transaction: HistoricalTransaction) {
    if (
      !transaction.categoryId ||
      !this.activeCategoryIds.has(transaction.categoryId) ||
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
