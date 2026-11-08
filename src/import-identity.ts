import { createHash } from 'node:crypto';
import type { EventStore, StoredEvent } from './db.js';
import { resolveAccount } from './routing.js';
import type { ParsedTransaction, ResolvedConfig } from './types.js';

// Keep the historical ID for the first occurrence, including pre-upgrade retries.
export function legacyImportId(tx: ParsedTransaction, accountKey: string, part = 'main') {
  return (
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
          part,
        ].join('|'),
      )
      .digest('hex')
  );
}

export function migrateImportIdentities(store: EventStore, config: ResolvedConfig) {
  const hold = store.importIdentityHold();
  if (hold)
    throw new Error(
      `Historical identity reservation missing for ${hold}; operator reconciliation required`,
    );
  store.db.transaction(() => {
    for (const event of store.legacyImportEvents()) {
      if (!event.parsed) {
        if (event.actual_transaction_id)
          throw new Error(
            `Historical write evidence without parsed data for ${event.id}; reconciliation required`,
          );
        store.completeImportIdentityMigration(event.id);
        continue;
      }
      const tx = JSON.parse(event.parsed) as ParsedTransaction;
      const account = resolveAccount(config.accounts, tx);
      if (!account && !tx.accountAlias)
        throw new Error(
          `Historical identity unresolved for ${event.id}; imports paused for reconciliation`,
        );
      for (const part of ['main', 'principal', 'fee']) {
        const id = legacyImportId(tx, account?.key ?? '', part);
        store.seedImportId(event.id, part, id);
      }
      store.completeImportIdentityMigration(event.id);
    }
  })();
}

export function importId(
  store: EventStore,
  event: StoredEvent,
  tx: ParsedTransaction,
  accountKey: string,
  part = 'main',
) {
  return store.reserveImportId(event.id, part, legacyImportId(tx, accountKey, part));
}
