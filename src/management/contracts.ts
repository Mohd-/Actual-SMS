import type { PayeeCatalog, PayeeView } from '../payees.js';
import type { Runtime } from '../runtime.js';
import type { ConfigEditor } from '../config-editor.js';
import type { EventStore } from '../db.js';
import type { listEvents, eventDetail } from '../event-queries.js';
import type { AppConfigFile, BankConfig } from '../types.js';

export type StatusView = ReturnType<Runtime['status']> & {
  counts: ReturnType<EventStore['counts']>;
  payeeMigrationPending: boolean;
};
export type ConfigFile = 'accounts' | 'banks' | 'parsing';
export interface ConfigEditableFiles {
  accounts: boolean;
  banks: boolean;
  parsing: boolean;
}
export type ConfigView = Awaited<ReturnType<ConfigEditor['read']>>;
export type EventPage = ReturnType<typeof listEvents>;
export type EventView = NonNullable<ReturnType<typeof eventDetail>>;
export interface PayeePage {
  rows: PayeeView[];
  accounts: { id: string; name: string }[];
  categories: PayeeCatalog['categories'];
  tags: PayeeCatalog['tags'];
  nextOffset: number | null;
  editable: boolean;
  migrationPending: boolean;
  suggestions: boolean;
}
export interface PatternView {
  source: string;
  flags: string;
}
export interface ParsingRuleView<T> {
  value: T;
  patterns: PatternView[];
}
export interface ParsingFileView {
  schemaVersion: 1;
  shared: {
    ignored: ParsingRuleView<string>[];
    kinds: ParsingRuleView<string>[];
    fields: Record<string, PatternView[]>;
  };
  templates?: {
    id: string;
    match: PatternView[];
    kind: string;
    fields: Record<string, PatternView[]>;
    required: string[];
  }[];
}
export type AccountsFileView = AppConfigFile;
export interface BanksFileView {
  banks: BankConfig[];
}
export interface ConfigCatalog {
  accounts: { id: string; name: string }[];
  categories: (PayeeCatalog['categories'][number] & { isIncome?: boolean; hidden?: boolean })[];
}
export interface ConfigModelView {
  revision: string;
  activeRevision: string | null;
  editable: boolean;
  editableFiles: ConfigEditableFiles;
  accounts: AccountsFileView;
  banks: BanksFileView;
  parsing: ParsingFileView;
  catalog: ConfigCatalog;
}
export interface ConfigPatch {
  file: ConfigFile;
  op: 'set' | 'insert' | 'delete' | 'move';
  path: (string | number)[];
  value?: unknown;
  from?: number;
  to?: number;
}
