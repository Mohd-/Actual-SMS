import type { MerchantAssignment } from '../merchant-assignments.js';
import type { Runtime } from '../runtime.js';
import type { ConfigEditor } from '../config-editor.js';
import type { EventStore } from '../db.js';
import type { listEvents, eventDetail } from '../event-queries.js';
export type StatusView = ReturnType<Runtime['status']> & {
  counts: ReturnType<EventStore['counts']>;
};
export type ConfigView = Awaited<ReturnType<ConfigEditor['read']>>;
export type EventPage = ReturnType<typeof listEvents>;
export type EventView = NonNullable<ReturnType<typeof eventDetail>>;
export interface AssignmentPage {
  rows: MerchantAssignment[];
  accounts: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  nextOffset: number | null;
}
