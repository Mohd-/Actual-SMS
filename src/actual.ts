import { loadActualApi, type ActualSession } from './actual-sdk.js';
import { preflightActualVersion } from './actual-version.js';
import type { ActualAdapter, ActualTransaction } from './types.js';

export class ActualApiAdapter implements ActualAdapter {
  constructor(
    private options: {
      serverURL: string;
      password: string;
      syncId: string;
      encryptionPassword?: string;
      dataDir: string;
    },
    private session?: ActualSession,
  ) {}
  async initialize() {
    await preflightActualVersion(this.options.serverURL);
    const actual = await loadActualApi();
    this.session = await actual.init({
      serverURL: this.options.serverURL,
      password: this.options.password,
      dataDir: this.options.dataDir,
    });
    await actual.downloadBudget(this.options.syncId, { password: this.options.encryptionPassword });
  }
  async serverVersion() {
    const actual = await loadActualApi();
    const result = await actual.getServerVersion();
    if ('version' in result) return result.version;
    throw new Error(result.error);
  }
  async shutdown() {
    const actual = await loadActualApi();
    this.session = undefined;
    await actual.shutdown();
  }
  async sync() {
    const actual = await loadActualApi();
    await actual.sync();
  }
  async accounts() {
    const actual = await loadActualApi();
    return (await actual.getAccounts())
      .filter(a => !a.closed)
      .map(a => ({ id: a.id, name: a.name }));
  }
  async categories() {
    const actual = await loadActualApi();
    return (await actual.getCategoryGroups()).flatMap(group =>
      (group.categories ?? []).map(category => ({
        id: category.id,
        name: category.name,
        groupName: group.name,
        isIncome: Boolean(category.is_income),
        hidden: Boolean(category.hidden),
      })),
    );
  }
  async payees() {
    const actual = await loadActualApi();
    return (await actual.getPayees()).map(payee => ({
      id: payee.id,
      name: payee.name,
      transferAccountId: payee.transfer_acct ?? undefined,
    }));
  }
  async tags() {
    if (!this.session) throw new Error('Actual session is unavailable');
    // The high-level getTags() drops the hidden flag in the pinned SDK.
    const tags = (await this.session.send('tags-get')) as {
      id: string;
      tag: string;
      hidden: boolean;
    }[];
    return tags.map(tag => ({ id: tag.id, name: tag.tag, hidden: tag.hidden }));
  }
  async transactions(accountId: string, startDate: string, endDate: string) {
    const actual = await loadActualApi();
    return (await actual.getTransactions(accountId, startDate, endDate)).map(transaction => ({
      id: transaction.id,
      accountId: transaction.account,
      date: transaction.date,
      payeeId: transaction.payee ?? undefined,
      importedPayee: transaction.imported_payee,
      categoryId: transaction.category,
      importedId: transaction.imported_id,
      transferId: transaction.transfer_id,
    }));
  }
  async importedTransactionPayee(accountId: string, transactionId: string, importedId: string) {
    const actual = await loadActualApi();
    const { data } = (await actual.aqlQuery(
      actual
        .q('transactions')
        .filter({
          id: transactionId,
          account: accountId,
          imported_id: importedId,
          transfer_id: null,
        })
        .select(['payee']),
    )) as { data: { payee: string | null }[] };
    return data[0]?.payee ?? undefined;
  }
  async transferPayee(accountId: string) {
    const actual = await loadActualApi();
    const payee = (await actual.getPayees()).find(p => p.transfer_acct === accountId);
    if (!payee) throw new Error(`No Actual transfer payee for account ${accountId}`);
    return payee.id;
  }
  async importTransactions(accountId: string, transactions: ActualTransaction[]) {
    const actual = await loadActualApi();
    const pending = transactions.some(transaction => transaction.preservePendingAssignment);
    // Only frozen import plans from the merchant-approval release carry this flag.
    if (pending && !('actualSmsPendingAssignmentImport' in actual))
      throw new Error('Actual SDK pending-assignment import support is missing');
    return actual.importTransactions(accountId, transactions as any, {
      defaultCleared: true,
      ...(pending ? { payeeNameNormalization: 'original' } : {}),
    });
  }
}
