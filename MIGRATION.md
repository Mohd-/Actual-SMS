# Moving an existing private deployment to the public upstream

Keep the private repository's original branch and remote. Its history can contain
personal account settings even when those paths are ignored at the current tip.
Start an integration branch from the public upstream and commit reviewed changes
there. Do not merge the private root history into a branch intended for publication.
Keep the upstream remote fetch-only unless a specific public push has been reviewed.

## Preserve local state

- Back up `.env`, `.gitenv`, `config/accounts.yaml`, local Compose overrides, and
  the existing deployment's project name, volume names, networks, and host mappings.
  Store these outside the public worktree with restrictive permissions.
- Back up the queue with SQLite's online backup API, or stop its writer before
  copying the database and WAL. Copying only a live SQLite main file is insufficient.
- Preserve both the queue and Actual cache volumes. A new checkout directory can
  change Compose's default project name and select empty volumes. Pin the existing
  project name and explicit volume names; external volume declarations help prevent
  accidentally deleting retained data.
- Keep account names, bank IDs, suffixes, and transfer identifiers unchanged for
  the first migration. Existing Actual names must resolve uniquely. Configured fee
  and eligible categories must be active expense categories, and configured eligible
  category names must be unique across active expense groups. Configured hidden or
  income categories are excluded from enrichment with a warning; local settings
  remain unchanged. Missing names still fail startup.
- Do not rerun setup with `--force` over an existing deployment. It replaces local
  credentials and account mappings, including the Tasker API key.

## Configuration changes

Mount `config/banks.yaml` and `config/parsing.yaml` alongside the account mapping.
The default container paths are `/config/banks.yaml` and `/config/parsing.yaml`.
Inventory actual SMS senders before switching: aliases now match the complete sender
after case and whitespace normalization. An unknown sender is skipped during inbox
sync, and its body is not retained for later replay.

For private customizations, copy the YAML files to `config/banks.local.yaml` and
`config/parsing.local.yaml` and set `BANKS_CONFIG_FILE` and `PARSING_CONFIG_FILE` in
the Compose environment. These host paths are ignored by Git and Docker. Container
paths remain unchanged. A host process must instead set `BANKS_CONFIG_PATH` and
`PARSING_CONFIG_PATH` to its local files, along with the other required environment
variables; `npm start` and `npm run dev` do not automatically load `.env`.

The received-SMS project export is no longer shipped by upstream, but `/v1/sms`
remains supported. An already imported Tasker project can continue to run. Keep
exactly one ingestion project and one active inbox phone. Preserve the server
checkpoint and original event IDs when retrying or reconciling. Without `eventId`,
retry the same original `receivedAt` instant, rather than the submission time.

The sample Compose mapping and health check follow `PORT`. Existing deployments
still need their own reverse-proxy network and hostname/IP mappings. Telegram
reporting now resolves the checkout relative to its script; cron can set
`ACTUAL_SMS_REPO_DIR` and an absolute `OPENCODE_BIN` when needed.

## Validation before cutover

1. Run `npm run check` and `npm run build` on the integration branch.
2. Compare the original local fixture corpus against the new parser and validate
   personal mappings without printing credentials, raw SMS, or account identifiers.
3. Migrate a private copy of the existing queue and verify event IDs, statuses,
   original payloads, audit history, and the inbox checkpoint are preserved.
4. Build the image and check native SQLite and Actual SDK loading with no network,
   production mounts, or credentials. Validate Compose separately with synthetic
   environment settings, including a non-default port and private YAML mounts.
5. Run the opt-in live smoke test only against a disposable Actual budget and cache.
   `npm run smoke:disposable` can create and verify removal of its own empty budget
   using server authentication, without opening the production budget. Never point
   the existing-budget smoke test at a production budget.

## Accounting changes

The parser excludes merchant values when recognizing notification and transaction
markers. A merchant containing `OTP`, `ATM`, or `Reversal` cannot change a purchase's
direction. Import dates preserve the parsed timestamp's offset independently of
the container's timezone; bank-local timestamps are parsed in `Asia/Riyadh`.

All Actual import results, including principal and fee writes, are checked for
errors. A matching transfer notification waits while its counterpart's import or
sync is incomplete. Retry and restart preserve the chosen import IDs and transfer
pairing, including an independently imported opposite side. All new dispatches,
including ordinary purchases, persist a versioned frozen account/payload/import-ID
plan in `import_executions` before writing. Identity reservations and execution
intent commit together. Successful main/principal/fee stages are retained separately;
counterpart notifications
wait without spending retry attempts. An exhausted owner fails its dependent
notification visibly rather than allowing another principal import.

The additive `import-execution:1` migration copies existing frozen transfer plans,
progress, completed matches, and holds into `import_executions` atomically. The
old `transfer_executions` table is retained as migration evidence, not consulted as
a second dispatch authority. Previously parsed, unimported ordinary transactions
without a trustworthy plan are held too: they may already have written without
returning an Actual ID. This extends the existing `transfer-execution:1` safeguards;
it does not replay completed imports or reconstruct write plans from current routing.

New transfer plans retain original endpoint evidence. Counterpart recognition runs
before current account routing: editing or removing either route cannot authorize
another linked principal for an already-covered notification. Amount/time proximity
alone is insufficient to match. Multiple plausible counterparts, inconsistent
endpoints, and relevant legacy plans lacking endpoint evidence fail closed for
reconciliation. Potentially related notifications near uncertain legacy transfers
also fail closed within the existing amount/time window. Reconcile these cases before cutover where
possible; otherwise preserve their failed status and evidence until both ledger
and queue have been deliberately reconciled. Do not clear holds or delete execution
records just to force another attempt. See [transfer recovery](docs/management.md#recover-incomplete-transfers).

The first transaction with a historical fingerprint retains the historical Actual
import ID. Later distinct events with that fingerprint receive a durable event-based
suffix. Pre-upgrade parsed events, including partially imported failures, reserve
their historical IDs before new work runs. Identity preparation runs only after
Actual configuration resolves and while the work gate remains exclusive. Initial
connection outages leave it pending; reconnect prepares identities before imports
resume. Each event is marked prepared only in the transaction that reserves its
identities. Unresolved historical dependencies keep readiness false and block queue
claims. Never-parsed legacy rows do not receive fabricated fingerprints.

On upgrade, already-marked parsed rows lacking reservations and a trustworthy plan
or completed counterpart record are recorded in `import_identity_holds`. They may
have been affected by the earlier outage-startup bug. Readiness stays false; the
service does not reset their migration flags or invent IDs from current routing.
Compare historical configuration, queue/audit evidence, and the Actual ledger on a
private backup before any deliberate repair. Even supplying a reservation later
does not automatically clear a recorded hold. Preserve all existing identities and
reconcile any later colliding imports as well. Do not blanket-reset migration flags,
delete holds, or replay messages as a diagnostic shortcut.

Keep `event_import_ids`, `import_executions`, `import_identity_holds`, the legacy
`transfer_executions`, and `transfers` with the queue and audit history. This depends
on stable source event IDs and the original durable queue;
changing ingestion sources or replaying notifications under new IDs can duplicate
transactions. A missing queue cannot reconstruct those identities from SMS alone.

Parser revision 16 requeues eligible retained unimported events once. Already
imported events are excluded, so old wrong dates or classifications need a separate
audit and manual correction in Actual. Subsequent YAML-only edits require a parser
revision bump to replay retained outcomes; inbox rewind only re-enqueues messages
that were not already retained under the same event ID.

## Cutover and rollback

Pause phone ingestion, stop the old processor, and refresh the queue and cache
backups before replacing the service. Keep the old image available. Start only one
processor with the retained volumes and saved deployment topology, verify readiness
and authenticated audit access, then resume the existing phone project. Review
replayed events and transfer failures before rewinding the inbox.

The schema additions are additive, but the old processor does not understand the
new identity and pending-transfer safeguards, including frozen execution plans and
legacy reconciliation holds. Drain or explicitly reconcile pending ordinary and transfer dispatches before
a downgrade; disabling management on the current image keeps those safeguards.
An image-only downgrade can conflate
new equal transactions or mishandle incomplete transfers. For rollback, stop the
new processor and reconcile any Actual writes before restoring a pre-cutover queue
and cache snapshot. Restoring SQLite does not undo transactions already synced to
Actual. Keep ingestion paused until the ledger and queue agree.

## Runtime compatibility

Use an Actual server version matching the exact API dependency pin. The image
and GitHub checks use Node 22. Older API clients must not be assumed compatible
with newer server migrations. Preserve recovery images privately and prefer a
client matching the server when recovering; reconcile remote writes before
restoring local state. The Docker build runs the complete repository check.
