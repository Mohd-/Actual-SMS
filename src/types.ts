export type EventStatus =
  'queued' | 'processing' | 'imported' | 'ignored' | 'needs_review' | 'imported_review' | 'failed';

export interface Location {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
}
export interface SmsInput {
  eventId?: string;
  sender?: string;
  message: string;
  receivedAt: string;
  location?: Location;
}
export interface InboxCheckpoint {
  date: number;
  rowId: number;
}
export interface InboxSyncRow {
  rowId: number;
  date: number;
  sender: string | null;
  message: string | null;
}
export type InboxSyncOutcome = 'queued' | 'duplicate' | 'unsupported' | 'empty';
export type TxKind =
  'purchase' | 'refund' | 'withdrawal' | 'transfer_in' | 'transfer_out' | 'card_payment';
export type Bank = string;
export interface BankConfig {
  id: Bank;
  templates?: string[];
  name: string;
  senders: string[];
  /** Legacy sender-optional messages only; never overrides a named sender. */
  messageAliases: string[];
  disposition: 'import' | 'needs_review';
}

export interface ParsedTransaction {
  bank: Bank;
  kind: TxKind;
  accountAlias?: string;
  amountCents: number | null;
  principalCents?: number;
  feeCents: number;
  payee: string;
  occurredAt: string;
  balanceCents?: number;
  foreign?: { currency: string; amount: number };
  note: string;
  transferCounterpartyAlias?: string;
  /** Identifier extracted specifically from a Biller/مفوتر field. */
  billPaymentIdentifier?: string;
}

export interface AccountConfig {
  actualName: string;
  match: {
    bank: Bank;
    accountSuffixes?: string[];
    /** Identifiers used only when this account is the destination of a transfer. */
    transferIdentifiers?: string[];
    /** Biller identifiers that route a bill payment to this account. */
    billPaymentIdentifiers?: string[];
    transactionKinds?: TxKind[];
    hasBalance?: boolean;
  };
}
export interface AppConfigFile {
  accounts: AccountConfig[];
  bankFeesCategory: string;
  eligibleCategories?: string[];
}
export interface ResolvedConfig {
  banks: BankConfig[];
  parsing: import('./parsing/config.js').ParserConfig;
  accounts: ResolvedAccount[];
  bankFeesCategoryId: string;
  eligibleCategories: { id: string; name: string }[];
}
export interface ResolvedAccount {
  key: string;
  id: string;
  name: string;
  match: AccountConfig['match'];
}
export interface ActualTransaction {
  date: string;
  amount: number;
  payee_name?: string;
  imported_payee?: string;
  payee?: string;
  category?: string;
  notes?: string;
  imported_id: string;
  cleared?: boolean;
}
/** Versioned write intent, retained unchanged across retries and restarts. */
export interface ImportPlan {
  version: 1;
  kind: 'ordinary' | 'transfer';
  accountId: string;
  sourceKey: string;
  targetKey?: string;
  /** Historical endpoint evidence, never a live routing configuration source. */
  endpoints?: { source: ResolvedAccount; target?: ResolvedAccount };
  parsed: ParsedTransaction;
  principalCents: number;
  main?: ActualTransaction;
  /** Absent when a completed counterpart already covers the principal. */
  principal?: ActualTransaction;
  fee?: ActualTransaction;
  review: boolean;
  matchedEventId?: string;
}
export interface ActualCategory {
  id: string;
  name: string;
  groupName?: string;
  isIncome?: boolean;
  hidden?: boolean;
}
export interface HistoricalTransaction {
  id: string;
  accountId: string;
  date: string;
  payeeName?: string;
  importedPayee?: string;
  categoryId?: string;
  importedId?: string;
  transferId?: string;
}
export interface ImportResult {
  added: string[];
  updated: string[];
  errors: { message: string }[];
}
export interface ActualAdapter {
  initialize(): Promise<void>;
  serverVersion(): Promise<string>;
  shutdown(): Promise<void>;
  sync(): Promise<void>;
  accounts(): Promise<{ id: string; name: string }[]>;
  categories(): Promise<ActualCategory[]>;
  transactions(
    accountId: string,
    startDate: string,
    endDate: string,
  ): Promise<HistoricalTransaction[]>;
  transferPayee(accountId: string): Promise<string>;
  importTransactions(accountId: string, transactions: ActualTransaction[]): Promise<ImportResult>;
}
export interface AiSuggestion {
  payee: string;
  categoryId: string;
  confidence: number;
  reason: string;
}
export interface Enricher {
  enrich(input: {
    merchant: string;
    location?: Location;
    occurredAt: string;
    categories: { id: string; name: string }[];
  }): Promise<EnrichmentResult>;
}

export type EnrichmentResult =
  | {
      status: 'success';
      suggestion: AiSuggestion;
      model: string;
      durationMs: number;
      httpStatus: number;
      response: unknown;
    }
  | {
      status: 'http_error' | 'invalid_response' | 'timeout' | 'network_error' | 'disabled';
      model?: string;
      durationMs: number;
      httpStatus?: number;
      response?: unknown;
      error?: string;
    };
