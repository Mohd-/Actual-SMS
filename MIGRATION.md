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
  category names must be unique across groups.
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
5. Run the opt-in live smoke test only against a disposable Actual budget and cache
   with explicit smoke-only credentials. Never substitute production budget settings.

## Accounting changes

The parser excludes merchant values when recognizing notification and transaction
markers. A merchant containing `OTP`, `ATM`, or `Reversal` cannot change a purchase's
direction. Import dates use the banking timezone, `Asia/Riyadh`, independently of
the container's timezone.

All Actual import results, including principal and fee writes, are checked for
errors. A matching transfer notification waits while its counterpart's import or
sync is incomplete. Retry and restart preserve the chosen import IDs and transfer
pairing, including an independently imported opposite side.

The first transaction with a historical fingerprint retains the historical Actual
import ID. Later distinct events with that fingerprint receive a durable event-based
suffix. Pre-upgrade parsed events, including partially imported failures, reserve
their historical IDs before new work runs. Keep the `event_import_ids` table with
the queue. This depends on stable source event IDs and the original durable queue;
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
new identity and pending-transfer safeguards. An image-only downgrade can conflate
new equal transactions or mishandle incomplete transfers. For rollback, stop the
new processor and reconcile any Actual writes before restoring a pre-cutover queue
and cache snapshot. Restoring SQLite does not undo transactions already synced to
Actual. Keep ingestion paused until the ledger and queue agree.
