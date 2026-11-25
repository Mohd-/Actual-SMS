import type { PayeeCatalog, PayeeView } from '../payees.js';
import type { Runtime } from '../runtime.js';
import type { ConfigEditor } from '../config-editor.js';
import type { EventStore } from '../db.js';
import type { listEvents, eventDetail } from '../event-queries.js';
export type StatusView = ReturnType<Runtime['status']> & {
  counts: ReturnType<EventStore['counts']>;
  payeeMigrationPending: boolean;
};
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
