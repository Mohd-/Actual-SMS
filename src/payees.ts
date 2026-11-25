import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { merchantKey } from './merchant-key.js';
import type { ActualPayee, ActualTag, HistoricalTransaction, ParsedTransaction } from './types.js';

interface Named {
  id: string;
  name: string;
}
export interface PayeeCatalog {
  payees: ActualPayee[];
  categories: (Named & { groupName?: string })[];
  tags: ActualTag[];
}
interface LegacyChoice {
  accountId: string;
  merchant: string;
  categoryId: string | null;
  payee?: string;
}
interface PayeeRow {
  id: string;
  name: string;
  actualId: string | null;
  active: number;
  categoryId: string | null;
  tags: string;
  conflict: string;
  revision: string;
}
interface AliasRow {
  key: string;
  name: string;
  payeeId: string;
  mode: 'auto' | 'observed' | 'linked' | 'separate';
}
export interface PayeeView {
  id: string;
  name: string;
  actualId: string | null;
  unavailable: boolean;
  categoryId: string | null;
  tagIds: string[];
  conflict: LegacyChoice[];
  revision: string;
  aliases: { key: string; name: string; linked: boolean }[];
}

const legacyTables = [
  'merchant_assignment_reviews',
  'merchant_mappings',
  'actual_mapping_observations',
  'local_mapping_observations',
] as const;
const migrationKey = 'payee-defaults-v1';
export class PayeeConflict extends Error {}

export class Payees {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS payees (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, nameKey TEXT NOT NULL, actualId TEXT UNIQUE, active INTEGER NOT NULL DEFAULT 1,
        categoryId TEXT, tags TEXT NOT NULL DEFAULT '[]', conflict TEXT NOT NULL DEFAULT '[]', revision TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payee_aliases (
        key TEXT PRIMARY KEY, name TEXT NOT NULL, payeeId TEXT NOT NULL REFERENCES payees(id), mode TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS payee_aliases_payee ON payee_aliases(payeeId);
      CREATE INDEX IF NOT EXISTS payees_name ON payees(nameKey);
      CREATE TABLE IF NOT EXISTS payee_catalog (id INTEGER PRIMARY KEY CHECK(id=1), categories TEXT NOT NULL, tags TEXT NOT NULL);
    `);
  }

  get migrationPending() {
    return (
      !this.db.prepare('SELECT 1 FROM service_migrations WHERE key=?').get(migrationKey) &&
      legacyTables.some(name => this.hasTable(name))
    );
  }

  private hasTable(name: string) {
    return this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  }

  get catalog() {
    const row = this.db.prepare('SELECT categories,tags FROM payee_catalog WHERE id=1').get() as
      { categories: string; tags: string } | undefined;
    return {
      categories: JSON.parse(row?.categories ?? '[]') as PayeeCatalog['categories'],
      tags: JSON.parse(row?.tags ?? '[]') as ActualTag[],
    };
  }

  private row(id: string) {
    return this.db.prepare('SELECT * FROM payees WHERE id=?').get(id) as PayeeRow | undefined;
  }

  private aliases(id: string) {
    return this.db
      .prepare('SELECT * FROM payee_aliases WHERE payeeId=? ORDER BY key')
      .all(id) as AliasRow[];
  }

  private view(row: PayeeRow): PayeeView {
    return {
      id: row.id,
      name: row.name,
      actualId: row.actualId,
      unavailable: !row.active,
      categoryId: row.categoryId,
      tagIds: JSON.parse(row.tags),
      conflict: JSON.parse(row.conflict),
      revision: row.revision,
      aliases: this.aliases(row.id).map(({ key, name, mode }, _, aliases) => ({
        key,
        name,
        linked:
          mode !== 'separate' &&
          (!!row.actualId || aliases.length > 1 || key !== merchantKey(row.name)),
      })),
    };
  }

  get(id: string) {
    const row = this.row(id);
    return row && this.view(row);
  }

  list(search: string, offset: number, limit: number) {
    const rows = this.db
      .prepare(
        `SELECT * FROM payees AS p
      WHERE (? = '' OR instr(p.nameKey, ?) > 0 OR EXISTS (
        SELECT 1 FROM payee_aliases a WHERE a.payeeId=p.id AND instr(a.key, ?) > 0))
      ORDER BY p.nameKey, p.id LIMIT ? OFFSET ?`,
      )
      .all(search, search, search, limit, offset) as PayeeRow[];
    return rows.map(row => this.view(row));
  }

  private matchingActual(key: string) {
    return this.db
      .prepare('SELECT * FROM payees WHERE actualId IS NOT NULL AND active=1 AND nameKey=? LIMIT 2')
      .all(key) as PayeeRow[];
  }

  private uniqueActual(key: string) {
    const matches = this.matchingActual(key);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private uniqueLocal(key: string) {
    const matches = this.db
      .prepare(
        `SELECT * FROM payees p WHERE actualId IS NULL AND nameKey=? AND NOT EXISTS (
      SELECT 1 FROM payee_aliases a WHERE a.payeeId=p.id AND a.mode='separate') LIMIT 2`,
      )
      .all(key) as PayeeRow[];
    return matches.length === 1 ? matches[0] : undefined;
  }

  private alias(key: string) {
    return this.db.prepare('SELECT * FROM payee_aliases WHERE key=?').get(key) as
      AliasRow | undefined;
  }

  private create(name: string) {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO payees(id,name,nameKey,revision) VALUES(?,?,?,?)')
      .run(id, name, merchantKey(name), randomUUID());
    return this.row(id)!;
  }

  private insertAlias(key: string, name: string, id: string, mode: AliasRow['mode']) {
    this.db
      .prepare('INSERT INTO payee_aliases(key,name,payeeId,mode) VALUES(?,?,?,?)')
      .run(key, name, id, mode);
  }

  private touch(id: string) {
    this.db.prepare('UPDATE payees SET revision=? WHERE id=?').run(randomUUID(), id);
  }

  private observe(name: string) {
    const key = merchantKey(name);
    if (!key) return;
    const alias = this.alias(key);
    if (alias) return this.row(alias.payeeId);
    const matches = this.matchingActual(key);
    if (matches.length > 1) {
      const row = this.create(name);
      this.insertAlias(key, name, row.id, 'separate');
      return row;
    }
    const row = matches[0] ?? this.uniqueLocal(key) ?? this.create(name);
    this.insertAlias(key, name, row.id, 'auto');
    this.touch(row.id);
    return this.row(row.id);
  }

  defaults(name: string, expenseCategories?: Named[]) {
    return this.db.transaction(() => {
      const payee = this.observe(name);
      if (!payee?.active) return;
      const catalog = this.catalog;
      const validCategories = expenseCategories ?? catalog.categories;
      const selectedTags = new Set(JSON.parse(payee.tags) as string[]);
      return {
        payeeId: payee.actualId ?? undefined,
        name: payee.name,
        categoryId: validCategories.some(category => category.id === payee.categoryId)
          ? payee.categoryId!
          : undefined,
        tags: catalog.tags.filter(tag => selectedTags.has(tag.id)).map(tag => tag.name),
      };
    })();
  }

  private observableAlias(name: string) {
    const alias = this.alias(merchantKey(name));
    if (!alias || (alias.mode !== 'auto' && alias.mode !== 'observed')) return;
    const payee = this.row(alias.payeeId);
    if (payee && (alias.mode === 'observed' || (!payee.actualId && !this.hasSettings(payee))))
      return alias;
  }

  shouldObserveActual(name: string) {
    return Boolean(this.observableAlias(name));
  }

  observeActual(name: string, actualId: string) {
    this.db.transaction(() => {
      const alias = this.observableAlias(name);
      if (!alias) return;
      const target = this.db
        .prepare('SELECT * FROM payees WHERE actualId=? AND active=1')
        .get(actualId) as PayeeRow | undefined;
      if (!target || target.id === alias.payeeId) return;
      // Different outcomes for the same descriptor require a manual decision.
      const learned = alias.mode === 'observed';
      const replacement = learned ? this.create(alias.name) : target;
      this.db
        .prepare('UPDATE payee_aliases SET payeeId=?, mode=? WHERE key=?')
        .run(replacement.id, learned ? 'separate' : 'observed', alias.key);
      this.touch(alias.payeeId);
      this.touch(replacement.id);
      this.removeEmptyLocal(alias.payeeId);
    })();
  }

  private hasSettings(row: PayeeRow) {
    return row.categoryId !== null || row.tags !== '[]' || row.conflict !== '[]';
  }

  private expect(id: string, revision: string) {
    const row = this.row(id);
    if (!row || row.revision !== revision)
      throw new PayeeConflict('Payee changed. Refresh the list and try again.');
    return row;
  }

  save(
    id: string,
    revision: string,
    categoryId: string | null,
    tags: string[],
    resolveCategoryConflict = false,
  ) {
    this.db.transaction(() => {
      const row = this.expect(id, revision);
      const catalog = this.catalog;
      if (
        categoryId &&
        categoryId !== row.categoryId &&
        !catalog.categories.some(category => category.id === categoryId)
      )
        throw new PayeeConflict('Select an active Actual expense category.');
      const previous = JSON.parse(row.tags) as string[];
      if (tags.some(id => !previous.includes(id) && !catalog.tags.some(tag => tag.id === id)))
        throw new PayeeConflict('Select existing Actual tags.');
      const conflict =
        resolveCategoryConflict || categoryId !== row.categoryId ? '[]' : row.conflict;
      this.db
        .prepare('UPDATE payees SET categoryId=?, tags=?, conflict=?, revision=? WHERE id=?')
        .run(categoryId, JSON.stringify([...new Set(tags)].sort()), conflict, randomUUID(), id);
    })();
  }

  link(
    key: string | null,
    sourceId: string,
    sourceRevision: string,
    targetId: string,
    targetRevision: string,
  ) {
    this.db.transaction(() => {
      const source = this.expect(sourceId, sourceRevision);
      const target = this.expect(targetId, targetRevision);
      if (
        source.id === target.id ||
        !target.active ||
        (key === null ? Boolean(source.active) : this.alias(key)?.payeeId !== source.id)
      )
        throw new PayeeConflict('Select a different available payee and a current descriptor.');
      if (
        (source.categoryId && target.categoryId && source.categoryId !== target.categoryId) ||
        (source.tags !== '[]' && target.tags !== '[]' && source.tags !== target.tags) ||
        source.conflict !== '[]' ||
        target.conflict !== '[]'
      )
        throw new PayeeConflict(
          'Resolve the different saved settings on these payees before linking.',
        );
      const moveSettings =
        key === null || (!source.actualId && this.aliases(source.id).length === 1);
      if (moveSettings) {
        this.db
          .prepare('UPDATE payees SET categoryId=?, tags=? WHERE id=?')
          .run(
            target.categoryId ?? source.categoryId,
            target.tags === '[]' ? source.tags : target.tags,
            target.id,
          );
      }
      if (key === null)
        this.db
          .prepare("UPDATE payee_aliases SET payeeId=?, mode='linked' WHERE payeeId=?")
          .run(target.id, source.id);
      else
        this.db
          .prepare("UPDATE payee_aliases SET payeeId=?, mode='linked' WHERE key=?")
          .run(target.id, key);
      if (moveSettings) this.db.prepare('DELETE FROM payees WHERE id=?').run(source.id);
      else this.touch(source.id);
      this.touch(target.id);
    })();
  }

  unlink(key: string, id: string, revision: string) {
    this.db.transaction(() => {
      this.expect(id, revision);
      const alias = this.alias(key);
      if (!alias || alias.payeeId !== id)
        throw new PayeeConflict('Descriptor changed. Refresh the list and try again.');
      if (!this.view(this.row(id)!).aliases.find(item => item.key === key)?.linked)
        throw new PayeeConflict('This SMS descriptor already uses a separate payee.');
      const row = this.create(alias.name);
      this.db
        .prepare("UPDATE payee_aliases SET payeeId=?, mode='separate' WHERE key=?")
        .run(row.id, key);
      this.touch(id);
      this.removeEmptyLocal(id);
    })();
  }

  private removeEmptyLocal(id: string) {
    this.db
      .prepare(
        `DELETE FROM payees WHERE id=? AND actualId IS NULL AND categoryId IS NULL AND tags='[]' AND conflict='[]'
       AND NOT EXISTS (SELECT 1 FROM payee_aliases WHERE payeeId=payees.id)`,
      )
      .run(id);
  }

  refresh(catalog: PayeeCatalog, history: HistoricalTransaction[] = []) {
    this.db.transaction(() => {
      const actualPayees = catalog.payees.filter(
        payee => !payee.transferAccountId && payee.name.trim(),
      );
      const old = this.db
        .prepare('SELECT * FROM payees WHERE actualId IS NOT NULL')
        .all() as PayeeRow[];
      const update = this.db
        .prepare(`INSERT INTO payees(id,name,nameKey,actualId,revision) VALUES(?,?,?,?,?)
        ON CONFLICT(actualId) DO UPDATE SET active=1,name=excluded.name,nameKey=excluded.nameKey,revision=excluded.revision
        WHERE active=0 OR name<>excluded.name`);
      for (const payee of actualPayees)
        update.run(randomUUID(), payee.name, merchantKey(payee.name), payee.id, randomUUID());
      const active = new Set(actualPayees.map(payee => payee.id));
      for (const payee of old) {
        if (active.has(payee.actualId!) || !payee.active) continue;
        this.db
          .prepare('UPDATE payees SET active=0,revision=? WHERE id=?')
          .run(randomUUID(), payee.id);
      }
      this.db
        .prepare(
          "DELETE FROM payees WHERE active=0 AND categoryId IS NULL AND tags='[]' AND conflict='[]' AND NOT EXISTS (SELECT 1 FROM payee_aliases WHERE payeeId=payees.id)",
        )
        .run();
      this.db
        .prepare('INSERT OR REPLACE INTO payee_catalog(id,categories,tags) VALUES(1,?,?)')
        .run(
          JSON.stringify(catalog.categories),
          JSON.stringify(catalog.tags.filter(tag => !tag.hidden && validTag(tag.name))),
        );
      if (this.migrationPending) this.migrate(history);
      this.promoteLocalPayees();
      this.db
        .prepare('INSERT OR IGNORE INTO service_migrations(key,value) VALUES(?,?)')
        .run(migrationKey, '1');
    })();
  }

  private promoteLocalPayees() {
    const rows = this.db
      .prepare(
        `SELECT * FROM payees p WHERE p.actualId IS NULL AND NOT EXISTS (
      SELECT 1 FROM payee_aliases a WHERE a.payeeId=p.id AND a.mode='separate')`,
      )
      .all() as PayeeRow[];
    for (const local of rows) {
      const actual = this.uniqueActual(merchantKey(local.name));
      if (!actual) continue;
      if (
        !actual.categoryId &&
        actual.tags === '[]' &&
        actual.conflict === '[]' &&
        !this.aliases(actual.id).length
      ) {
        this.db.prepare('DELETE FROM payees WHERE id=?').run(actual.id);
        this.db
          .prepare('UPDATE payees SET actualId=?,name=?,nameKey=?,revision=? WHERE id=?')
          .run(actual.actualId, actual.name, merchantKey(actual.name), randomUUID(), local.id);
      } else if (!this.hasSettings(local)) {
        this.db
          .prepare('UPDATE payee_aliases SET payeeId=? WHERE payeeId=?')
          .run(actual.id, local.id);
        this.db.prepare('DELETE FROM payees WHERE id=?').run(local.id);
        this.touch(actual.id);
      }
    }
  }

  private migrate(history: HistoricalTransaction[]) {
    const legacy = readLegacy(this.db, name => Boolean(this.hasTable(name)));
    const names = new Map<string, string>();
    const observed = new Map<string, Set<string>>();
    const imported = new Set(
      (
        this.db.prepare('SELECT imported_id FROM event_import_ids').all() as {
          imported_id: string;
        }[]
      ).map(row => row.imported_id),
    );
    const importedTransactions = new Set(
      (
        this.db
          .prepare(
            'SELECT actual_transaction_id FROM events WHERE actual_transaction_id IS NOT NULL',
          )
          .all() as { actual_transaction_id: string }[]
      ).map(row => row.actual_transaction_id),
    );
    const actualById = new Map(
      (
        this.db
          .prepare('SELECT id,actualId FROM payees WHERE active=1 AND actualId IS NOT NULL')
          .all() as { id: string; actualId: string }[]
      ).map(row => [row.actualId, row.id]),
    );
    const remember = (name: string) => {
      const key = merchantKey(name);
      if (key && !names.has(key)) names.set(key, name);
    };
    const events = this.db
      .prepare('SELECT id,parsed,status FROM events WHERE parsed IS NOT NULL')
      .iterate() as Iterable<{ id: string; parsed: string; status: string }>;
    const descriptors = new Map<string, string>();
    for (const { id, parsed, status } of events) {
      const transaction = JSON.parse(parsed) as ParsedTransaction;
      if (
        !transaction.payee ||
        transaction.kind.startsWith('transfer') ||
        transaction.kind === 'card_payment' ||
        transaction.kind === 'withdrawal'
      )
        continue;
      if (status === 'imported' || status === 'imported_review') remember(transaction.payee);
      descriptors.set(id, transaction.payee);
    }
    for (const transaction of history) {
      if (
        transaction.transferId ||
        !transaction.importedPayee ||
        !transaction.payeeId ||
        (!importedTransactions.has(transaction.id) && !imported.has(transaction.importedId ?? ''))
      )
        continue;
      const id = actualById.get(transaction.payeeId);
      const key = merchantKey(transaction.importedPayee);
      if (id && key) {
        remember(transaction.importedPayee);
        addCandidate(observed, key, id);
      }
    }
    const explicit = new Map<string, Set<string>>();
    const decisions = new Map<string, LegacyChoice[]>();
    const descriptorChoices = new Map<string, LegacyChoice[]>();
    const descriptorConflicts = new Map<string, string>();
    const canonical = new Map<string, string>();
    for (const entry of legacy) {
      if (!entry.merchant) continue;
      const descriptor = descriptors.get(entry.sourceRef ?? '');
      remember(
        descriptor && merchantKey(descriptor) === entry.merchant ? descriptor : entry.merchant,
      );
      if (entry.status !== 'approved' || !entry.payee) continue;
      if (!entry.managed) continue;
      const nameKey = merchantKey(entry.payee) || entry.merchant;
      const exactPayee = this.uniqueActual(nameKey);
      const id = exactPayee?.id ?? canonical.get(nameKey) ?? this.create(entry.payee).id;
      canonical.set(nameKey, id);
      addCandidate(explicit, entry.merchant, id);
      const choice = {
        accountId: entry.accountId,
        merchant: entry.merchant,
        categoryId: entry.categoryId,
        payee: entry.payee,
      };
      appendChoice(decisions, id, choice);
      appendChoice(descriptorChoices, entry.merchant, choice);
    }
    for (const [key, name] of names) {
      const candidates = explicit.get(key) ?? observed.get(key);
      const id = candidates?.size === 1 ? [...candidates][0] : undefined;
      if (id) this.insertAlias(key, name, id, explicit.has(key) ? 'linked' : 'observed');
      else if (candidates?.size) {
        const local = this.create(name);
        this.insertAlias(key, name, local.id, 'separate');
        const choices = descriptorChoices.get(key);
        if (choices) {
          descriptorConflicts.set(key, local.id);
          decisions.set(local.id, choices);
        }
      } else this.observe(name);
    }
    for (const entry of legacy) {
      if (entry.status !== 'deleted') continue;
      const descriptor = descriptorConflicts.get(entry.merchant);
      const ids = descriptor
        ? [descriptor]
        : (explicit.get(entry.merchant) ?? [this.alias(entry.merchant)?.payeeId]);
      for (const id of ids)
        if (id && decisions.has(id))
          appendChoice(decisions, id, {
            accountId: entry.accountId,
            merchant: entry.merchant,
            categoryId: null,
          });
    }
    const ambiguousPayees = new Set(descriptorConflicts.values());
    for (const [id, choices] of decisions) {
      const categories = new Set(choices.map(choice => choice.categoryId));
      const hasConflict = categories.size > 1 || ambiguousPayees.has(id);
      this.db
        .prepare('UPDATE payees SET categoryId=?,conflict=?,revision=? WHERE id=?')
        .run(
          hasConflict ? null : choices[0]!.categoryId,
          JSON.stringify(hasConflict ? choices : []),
          randomUUID(),
          id,
        );
    }
    this.db.exec('DROP VIEW IF EXISTS merchant_assignments');
    for (const table of legacyTables) this.db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

function appendChoice(map: Map<string, LegacyChoice[]>, id: string, choice: LegacyChoice) {
  const choices = map.get(id) ?? [];
  choices.push(choice);
  map.set(id, choices);
}

function addCandidate(map: Map<string, Set<string>>, key: string, id: string) {
  let values = map.get(key);
  if (!values) map.set(key, (values = new Set()));
  values.add(id);
}

function validTag(name: string) {
  return /^[^#\s]+$/u.test(name);
}

interface LegacyRow {
  accountId: string;
  merchant: string;
  payee: string;
  categoryId: string;
  status: string;
  sourceRef: string | null;
  managed: number;
}

function readLegacy(db: Database.Database, hasTable: (name: string) => boolean) {
  const rows: LegacyRow[] = [];
  if (hasTable('merchant_assignment_reviews')) {
    for (const row of db
      .prepare(
        'SELECT accountId,merchant,payee,categoryId,status,sourceRef,1 AS managed FROM merchant_assignment_reviews ORDER BY accountId, merchant',
      )
      .iterate() as Iterable<LegacyRow>)
      rows.push(row);
  }
  for (const table of [
    'merchant_mappings',
    'actual_mapping_observations',
    'local_mapping_observations',
  ] as const) {
    if (!hasTable(table)) continue;
    for (const row of db
      .prepare(`SELECT DISTINCT merchant_key AS merchant FROM ${table} ORDER BY merchant`)
      .iterate() as Iterable<{ merchant: string }>)
      rows.push({
        merchant: row.merchant,
        accountId: '',
        payee: '',
        categoryId: '',
        status: 'historical',
        sourceRef: null,
        managed: 0,
      });
  }
  return rows;
}
