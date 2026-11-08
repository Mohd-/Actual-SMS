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
  store.db.transaction(() => {
    for (const event of store.legacyImportEvents()) {
      const tx = JSON.parse(event.parsed!) as ParsedTransaction;
      const account = resolveAccount(config.accounts, tx);
      if (!account && !tx.accountAlias) continue;
      for (const part of ['main', 'principal', 'fee']) {
        const id = legacyImportId(tx, account?.key ?? '', part);
        store.seedImportId(event.id, part, id);
      }
    }
    store.completeImportIdentityMigration();
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
