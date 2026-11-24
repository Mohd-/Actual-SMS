import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AiSuggestion } from './types.js';
import { merchantKey } from './merchant-key.js';

export interface MerchantAssignment {
  accountId: string;
  merchant: string;
  payee: string;
  categoryId: string;
  managed: 0 | 1;
  status: 'approved' | 'pending' | 'deleted';
  source: 'actual' | 'local' | 'ai' | 'manual';
  sourceRef: string | null;
  confidence: number | null;
  reason: string | null;
  revision: string;
}

type AssignmentInput = Pick<MerchantAssignment, 'accountId' | 'merchant' | 'payee' | 'categoryId'>;

export class AssignmentConflict extends Error {
  constructor() {
    super('Merchant assignment changed. Refresh the list and try again.');
  }
}

export class MerchantAssignments {
  constructor(private readonly db: Database.Database) {
    db.function('normalize_merchant', { deterministic: true }, (value: string) =>
      merchantKey(value),
    );
    db.exec(`
      CREATE TABLE IF NOT EXISTS merchant_assignment_reviews (
        accountId TEXT NOT NULL, merchant TEXT NOT NULL, payee TEXT NOT NULL,
        categoryId TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
        sourceRef TEXT, confidence REAL, reason TEXT, revision TEXT NOT NULL,
        PRIMARY KEY (accountId, merchant)
      );
    `);
    this.db.transaction(() => {
      const columns = db.pragma('table_info(merchant_assignments)') as { name: string }[];
      if (columns.some(column => column.name === 'managed')) return;
      db.exec(`
      DROP VIEW IF EXISTS merchant_assignments;
      CREATE VIEW merchant_assignments AS
        SELECT accountId, merchant, payee, categoryId, 1 AS managed, status, source, sourceRef, confidence,
          reason, revision FROM merchant_assignment_reviews
        UNION ALL
        SELECT account_id, merchant_key, payee, category_id, 0, 'approved', source, source_ref,
          NULL, NULL, json_array(decision_at, payee, category_id, source, source_ref)
        FROM merchant_mappings AS history
        WHERE merchant_key <> '' AND NOT EXISTS (
          SELECT 1 FROM merchant_assignment_reviews AS review
          WHERE review.accountId = history.account_id AND review.merchant = history.merchant_key
        );
      `);
    })();
  }

  get(accountId: string, merchant: string) {
    return this.db
      .prepare('SELECT * FROM merchant_assignments WHERE accountId = ? AND merchant = ?')
      .get(accountId, merchant) as MerchantAssignment | undefined;
  }

  list(search: string, offset: number, limit: number) {
    return this.db
      .prepare(
        `SELECT * FROM merchant_assignments WHERE status != 'deleted'
        AND (? = '' OR instr(merchant, ?) > 0 OR instr(normalize_merchant(payee), ?) > 0)
        ORDER BY (status = 'pending') DESC, merchant, accountId LIMIT ? OFFSET ?`,
      )
      .all(search, search, search, limit, offset) as MerchantAssignment[];
  }

  suggest(
    accountId: string,
    merchant: string,
    suggestion: AiSuggestion,
    eventId: string,
    canReplaceHistory: (assignment: MerchantAssignment) => boolean = () => false,
  ) {
    return this.db.transaction(() => {
      const existing = this.get(accountId, merchant);
      if (existing && (existing.managed || !canReplaceHistory(existing))) return existing;
      const assignment: MerchantAssignment = {
        accountId,
        merchant,
        payee: suggestion.payee,
        categoryId: suggestion.categoryId,
        managed: 1,
        status: 'pending',
        source: 'ai',
        sourceRef: eventId,
        confidence: suggestion.confidence,
        reason: suggestion.reason,
        revision: randomUUID(),
      };
      this.write(assignment);
      return assignment;
    })();
  }

  save(input: AssignmentInput, expected: string | null) {
    return this.db.transaction(() => {
      const current = this.get(input.accountId, input.merchant);
      if ((current?.status === 'deleted' ? null : (current?.revision ?? null)) !== expected)
        throw new AssignmentConflict();
      const unchanged = current?.payee === input.payee && current.categoryId === input.categoryId;
      this.write({
        ...input,
        status: 'approved',
        source: unchanged ? current.source : 'manual',
        sourceRef: unchanged ? current.sourceRef : null,
        confidence: unchanged ? current.confidence : null,
        reason: unchanged ? current.reason : null,
        revision: randomUUID(),
      });
    })();
  }

  delete(accountId: string, merchant: string, expected: string) {
    return this.db.transaction(() => {
      const current = this.get(accountId, merchant);
      if (!current || current.revision !== expected || current.status === 'deleted')
        throw new AssignmentConflict();
      // Keep the key so refreshes and later SMS messages respect the decision.
      this.write({
        accountId,
        merchant,
        payee: '',
        categoryId: '',
        status: 'deleted',
        source: 'manual',
        sourceRef: null,
        confidence: null,
        reason: null,
        revision: randomUUID(),
      });
    })();
  }

  private write(assignment: Omit<MerchantAssignment, 'managed'>) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO merchant_assignment_reviews
        (accountId, merchant, payee, categoryId, status, source, sourceRef, confidence, reason, revision)
        VALUES (@accountId, @merchant, @payee, @categoryId, @status, @source, @sourceRef,
          @confidence, @reason, @revision)`,
      )
      .run(assignment);
  }
}
