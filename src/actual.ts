import { loadActualApi } from './actual-sdk.js';
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
  ) {}
  async initialize() {
    const actual = await loadActualApi();
    await actual.init({
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
    const groups = await actual.getCategories();
    return groups.map(c => ({
      id: c.id,
      name: c.name,
      groupName: (c as any).group?.name,
      isIncome: Boolean((c as any).is_income),
      hidden: Boolean((c as any).hidden),
    }));
  }
  async transactions(accountId: string, startDate: string, endDate: string) {
    const actual = await loadActualApi();
    const payees = new Map((await actual.getPayees()).map(payee => [payee.id, payee.name]));
    return (await actual.getTransactions(accountId, startDate, endDate)).map(transaction => ({
      id: transaction.id,
      accountId: transaction.account,
      date: transaction.date,
      payeeName: transaction.payee ? payees.get(transaction.payee) : undefined,
      importedPayee: transaction.imported_payee,
      categoryId: transaction.category,
      importedId: transaction.imported_id,
      transferId: transaction.transfer_id,
    }));
  }
  async transferPayee(accountId: string) {
    const actual = await loadActualApi();
    const payee = (await actual.getPayees()).find(p => p.transfer_acct === accountId);
    if (!payee) throw new Error(`No Actual transfer payee for account ${accountId}`);
    return payee.id;
  }
  async importTransactions(accountId: string, transactions: ActualTransaction[]) {
    const actual = await loadActualApi();
    return actual.importTransactions(accountId, transactions as any, { defaultCleared: true });
  }
}
