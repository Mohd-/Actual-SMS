# Manage the importer in a browser

The optional management page is available at `/manage`. It provides importer status, read-only SMS audit, structured account routing and bank configuration, a recognition grammar workbench with a live SMS tester, interactive payee defaults, and guided Tasker setup. It does not contain a financial dashboard or another parser. Manual transaction approval remains disabled pending the separate design gate in the [adoption plan](web-management-adoption-plan.md). The interface design and acceptance record is in the [management UI/UX plan](management-ui-ux-plan.md).

Existing environment/CLI/YAML installations do not need management enabled. Keep your Actual credentials, API key, YAML, volume names, and Compose project name unchanged when adding it.

## Enable read-only management

Use the existing setup wizard or manual configuration first. Missing files, invalid YAML, and missing or ambiguous Actual account/category names remain startup errors. Management is a recovery interface for connection outages, not a replacement for initial configuration validation.

1. Generate a strong management password hash locally. With host dependencies installed, run the following in Bash; the plaintext password is read without echo and never placed in command arguments:

   ```sh
   read -r -s -p 'Management password: ' MANAGEMENT_PASSWORD
   printf '\n'
   printf '%s' "$MANAGEMENT_PASSWORD" | npm run --silent management:password
   unset MANAGEMENT_PASSWORD
   ```

   Use at least 12 characters and at most 72 UTF-8 bytes. Copy the generated `MANAGEMENT_PASSWORD_HASH='...'` line into your private `.env`. **Keep the single quotes:** Compose must not interpolate the dollar signs in a bcrypt hash.

   Alternatively, after building the image, pipe the password to its production CLI:

   ```sh
   read -r -s -p 'Management password: ' MANAGEMENT_PASSWORD
   printf '\n'
   printf '%s' "$MANAGEMENT_PASSWORD" | docker run --rm -i \
     --entrypoint node YOUR_BUILT_IMAGE dist/src/management/password.js
   unset MANAGEMENT_PASSWORD
   ```

2. Generate an independent session secret:

   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. Add these settings to `.env`, using the generated values:

   ```dotenv
   MANAGEMENT_URL=https://sms.example.test
   MANAGEMENT_SECRET=YOUR_GENERATED_64_HEX_CHARACTERS
   MANAGEMENT_PASSWORD_HASH='YOUR_GENERATED_BCRYPT_HASH'
   ```

   `MANAGEMENT_URL` is the exact browser origin, including a non-default port, with no trailing slash or path. HTTPS is required except for loopback HTTP such as `http://localhost:3000`. The example strings above are placeholders, not valid credentials.

4. Enable management without changing the default read-only mounts:

   ```sh
   docker compose -f compose.example.yaml -f compose.management.example.yaml up --build -d
   ```

5. Forward the service through your existing HTTPS reverse proxy, then open `MANAGEMENT_URL/manage`. Sign in with the password you hashed. There is no public owner-registration endpoint and no username.

The service uses the configured origin for write protection, not forwarded host headers. It does not trust forwarded client-IP headers. Login throttling is applied to the direct peer IP, so users behind one reverse proxy share a login-attempt limit. Do not enable broad proxy trust to bypass that limit. Browser sessions expire after eight hours; sign out or use **Sign out all sessions** to revoke them immediately. Changing the password hash and recreating the container invalidates sessions signed in against the old hash. Keep the independent session secret private and stable; changing it invalidates encrypted browser cookies.

The management password/session is separate from `API_KEY`. Neither grants the other's route permissions. Restricted Tasker keys also cannot access management or event history.

## Inspect SMS without changing transactions

**Overview** shows import readiness, the active configuration revision, queue counts by status, and a sanitized connection error. Refreshing or leaving the page open does not download Actual transaction history. **Reconnect Actual** drains engine work before replacing the configured session. It does not accept new credentials or switch budgets; edit the deployment environment and restart for credential changes.

**SMS audit** lists event metadata with cursor pagination and filters for status, date range, and enrichment outcome. Select a message to open an authenticated detail drawer with its original SMS, parsed result, category suggestion, enrichment attempts, and processing history. Raw SMS and location are not included in summary lists or URLs. There is no approval button, transaction edit, hard reset, or deletion workflow. Correct imported transactions in Actual.

Unknown-sender inbox content continues to be discarded rather than retained for the dashboard. Registered review-only banks keep their existing review behavior.

`/healthz` means the process can answer requests. `/readyz` requires a resolved configuration, an initialized Actual session, completed historical identity preparation, and an importer that is not paused, changing configuration, reconnecting, or shutting down. Identity preparation waits through initial connection outages and runs under the work gate before processing resumes. Unresolved historical dependencies or recorded identity-reconciliation holds keep imports paused; queue claims cannot bypass this preparation. A working login page alone is not import readiness. The integrated upstream version gate checks server metadata before opening the budget; a mismatch or failed discovery blocks imports. Readiness still cannot guarantee every future import succeeds.

The upstream `/v1/maintenance` operation remains available only to the legacy operator API key, not browser sessions or restricted Tasker keys. It persists the existing maintenance marker beside the queue database, blocks new engine work, drains imports and catalog refreshes, and shuts down the configured Actual session. A process started with that marker still accepts authenticated SMS into the durable queue but does not connect to Actual. Browser reconnect and configuration activation cannot override maintenance; clear the marker only through the existing deliberate deployment/restart workflow.

## Set automatic payee defaults

Open **Payees** to browse the Actual payee catalog and merchants known from SMS. Search by payee name or SMS descriptor. The table shows each payee's category, tags, descriptors, and state. When editing is available, change a category directly in the table; open a row to edit tags, inspect descriptors, link or separate a descriptor, and resolve migration conflicts. The category and tag settings apply across routed accounts and can be set independently.

Linking a descriptor to another payee uses that payee's defaults. Separating a descriptor creates a local payee with blank defaults. If Actual assigns an unconfigured descriptor to a known payee during a new import, the importer can link it automatically. Conflicting results leave the descriptor separate for you to link. Actual rules can override the category, payee, and notes on import.

With OpenCode Go configured, an uncategorized payee shows **Suggest category**. The request is user-triggered; the suggestion is applied to the editor draft only after you select **Use suggestion** and save. Previously imported transactions can be corrected in Actual.

The existing payee catalog is available while disconnected. Reconnect to edit it. Unavailable categories or tags remain visible in saved settings for replacement or removal. A payee with a migration conflict shows the previous choices. You can edit its tags while the category remains unresolved. Choose a category or select **Leave uncategorized** to resolve the conflict.

## Edit account routing

Open **Routing** for a structured editor over `CONFIG_PATH`. No YAML text editing is required:

- Account cards group one or more routing rules that target the same Actual account.
- Each rule selects a bank and can add account suffixes, transaction kinds, balance presence, transfer identifiers, and bill-payment identifiers.
- Global settings choose the bank-fees category and whether all active expense categories or only selected categories are eligible for suggestions.
- **Review changes** validates the complete configuration and shows a readable change summary before activation.
- A read-only YAML disclosure remains available for inspection and recovery; it is not an editor.

Actual account and category names must already exist exactly once in the configured budget. The service never creates them. The editor preserves comments, ordering, unrelated fields, and multiple non-overlapping rules for one account by applying targeted changes to the YAML document.

### Explicitly enable writes

The default account file is mounted read-only. Atomic replacement requires a writable directory mount; making only a single-file mount writable is insufficient.

To opt in, deliberately select a dedicated account directory:

```sh
mkdir -p config/editable
cp config/accounts.yaml config/editable/accounts.yaml
# Set ownership/permissions for the non-root node user in your image.
# Inspect the image UID/GID rather than assuming your host user matches it.
docker run --rm --entrypoint id YOUR_BUILT_IMAGE
```

Grant only that user and your intended host operator access to the editable directory and its account file. Do not use world-writable permissions or mount the repository root. Then start:

```sh
docker compose -f compose.example.yaml \
  -f compose.management.example.yaml \
  -f compose.management-edit.example.yaml up --build -d
```

The editing override explicitly sets `CONFIG_PATH=/editable/accounts.yaml`. **That selected file is now authoritative.** The original `config/accounts.yaml` remains mounted read-only but is no longer active; it is not a second live configuration source. Use your selected file consistently for future manual edits and backups. Existing bank/parser mounts remain read-only. No file is copied or relocated automatically by the application.

For a non-Docker deployment, set `MANAGEMENT_ENABLED=1` and `MANAGEMENT_EDIT_ACCOUNTS=1` explicitly, and use a regular, non-symlink account file in an appropriately protected writable directory.

### Validate, save, and recover

1. Open **Routing** and inspect the persisted and active revisions. A difference means disk and the running importer do not currently match.
2. Add or edit account rules. Names must resolve exactly once in the configured Actual budget; overlapping rules and missing banks are reported before saving.
3. Select **Review changes**, review the summary, and confirm **Save and activate**.
4. The operation drains engine work, validates the complete configuration, checks the revision again, writes atomically, and activates the derived snapshot.

Confirmation is bound to the exact draft and file revision. The editor and its controls stay locked from the start of validation through confirmation and activation. Cancelling the review returns you to your draft.

Preview and save each perform a server-backed Actual sync before resolving accounts and categories from the local budget. A previous successful connection or cached account list is not sufficient. Invalid candidates leave a healthy importer running with its old configuration. A sync/connection failure instead rejects the operation before any file replacement or recovery-copy creation, keeps imports paused without consuming queued-event attempts, and exposes a sanitized status error. After fixing the connection, use **Reconnect Actual** or **Validate and activate disk configuration**. A successful preview alone does not resume paused imports.

If another browser or an external edit changed any configuration dependency, saving returns a conflict. The draft remains visible. Use **Reload files** to refresh the editor and review the newer content. Revision checks are not a lock on arbitrary editors: coordinate a maintenance window and do not write externally during a browser save.

A protected `accounts.yaml.previous` copy is created on the first browser save and never overwritten automatically. It is an operator recovery copy, not runtime configuration; rotate or replace it deliberately when appropriate. The application does not keep every historical YAML version. Temporary replacement files are removed after failures where possible. Back up the configured files independently.

If replacement completed but activation/durability became uncertain, imports remain paused. Inspect the files and displayed revisions, then use **Validate and activate disk configuration** or restart after fixing the cause. Do not treat an error as a successful active change. The application does not automatically restore an older file over a possible external edit.

External edits still take effect on restart. From any configuration screen, **Validate and activate disk configuration** validates and activates the current files together without restarting. **Reload files** refreshes the editor and leaves the running configuration unchanged. There is no file watcher or automatic historical SMS replay.

## Edit the bank registry

Set `MANAGEMENT_EDIT_BANKS=1` (with management enabled) and use a writable `BANKS_CONFIG_PATH` directory to edit the **Banks** screen. Bank cards expose the display name, immutable ID, import disposition, sender aliases, message aliases, and associated parsing templates. Duplicate normalized aliases, unknown template references, and references from account routes are rejected by full-configuration validation.

Bank IDs are permanent because account routing and notification deduplication use them. The editor never renames an existing ID; adding a bank requires a new stable slug. **Review changes** follows the same atomic save, revision conflict, backup, and activation rules as account routing.

To make both bank and recognition files writable, prepare them in the same protected directory and add the grammar override:

```sh
cp config/banks.yaml config/editable/banks.yaml
cp config/parsing.yaml config/editable/parsing.yaml
docker compose -f compose.example.yaml \
  -f compose.management.example.yaml \
  -f compose.management-edit.example.yaml \
  -f compose.management-grammar.example.yaml up --build -d
```

## Edit recognition grammar

Set `MANAGEMENT_EDIT_PARSING=1` (with management enabled) and use a writable `PARSING_CONFIG_PATH` directory to edit **Recognition**. The screen exposes ignored-message rules, transaction-kind precedence, shared extractor patterns, and templates:

- Patterns can be added, edited, removed, and reordered. Order is semantically significant.
- Regexes are compiled and validated, and required named captures are checked before saving.
- **Test message** runs the real parser against the draft configuration without creating an event.
- **Review changes** validates the complete grammar, templates, and bank references before activation.
- The parser revision remains a code release constant; saving configuration does not silently replay retained events.

Without the editing opt-in, the same screen remains a read-only grammar explorer with the live tester. Invalid drafts never replace the active configuration.

## Recover incomplete transfers

All new dispatches, including ordinary purchases, retain a versioned frozen execution plan in `import_executions` before the first Actual write. The plan and identity reservations commit together. Account IDs, transaction payloads, and import IDs remain fixed across retries, restarts, and later routing edits. Main, principal, and fee progress are recorded separately, including returned IDs from partial results. A successful write is not repeated just because a later fee or sync failed; an uncertain write is retried with the same identity and account. Existing executions resume before parsing, balance inference, or enrichment can change their payload. An event completes only after its outstanding writes and sync succeed.

A matching notification waits without consuming its own retry budget while the owning event is incomplete. If the owner exhausts retries, the dependent event becomes failed with the owner's event ID in its operational error. When the linked credit arrived first, the debit can still import its outstanding fee without importing another principal. Inspect the authenticated audit; a successful principal does not mean the fee or matching notification completed. There is no browser approval or force-retry workflow.

Counterpart recognition uses the original endpoint evidence before current routing. A route can be changed or removed without redirecting a covered notification. Amount and time alone never prove a match: multiple plausible counterparts or inconsistent endpoint evidence are held for reconciliation rather than authorizing another principal. An older frozen plan without enough endpoint evidence may resume its own writes safely while a later notification remains held.

On upgrade, existing frozen transfer plans, stage progress, completed matches, and holds migrate into the single `import_executions` authority. Previously parsed, unimported ordinary transactions without a trustworthy plan are held too, even if no Actual ID was returned. The operational error states that the historical import requires operator reconciliation. Potentially related notifications near uncertain legacy transfers also fail closed. Completed imports, untouched queue entries, checkpoint state, and existing identities are preserved; this migration does not repair or replay financial history.

Already-marked historical rows lacking reservations and trustworthy execution/match evidence are recorded in `import_identity_holds`. This detects possible damage from the earlier outage-startup migration bug and keeps readiness false. The service neither resets their migration flags nor derives replacement identities from current routing. Investigate against historical configuration, authenticated audit evidence, and Actual before any deliberate repair; supplying an identity alone does not automatically clear a recorded hold. See [identity migration requirements](../MIGRATION.md#accounting-changes).

Reconcile incomplete ordinary imports and transfers before upgrading when possible. For a legacy hold or exhausted/ambiguous dispatch, preserve the queue and cache, pause ingestion, and compare authenticated event history and recorded identities with the ledger in Actual. Any recovery must deliberately reconcile both queue evidence and Actual writes; do not delete dispatch records, clear holds, change event IDs, or re-enqueue messages as a diagnostic shortcut. See [migration and rollback requirements](../MIGRATION.md#cutover-and-rollback).

## Configure Tasker

1. In **Phone setup**, generate a restricted key. It is returned only once; the server stores its hash rather than recoverable plaintext. The browser keeps it only in the current form, never local storage.
2. Enter the public HTTPS origin reachable by your phone. It must have no path, query, fragment, or embedded credentials.
3. Enter the public HTTPS origin reachable by your phone, download the configured project, and import it into Tasker using the existing permission/background-activity instructions in the [README](../README.md#4-connect-tasker). Protect the downloaded XML and Tasker backups as credentials.
4. If you reload the browser without saving the project, paste the current key from a secure copy or generate a new one. Replacing a key invalidates the old restricted key immediately; download and import a replacement project on the active phone.

Viewing settings, exporting a project, and rotating a key never initialize or move the inbox checkpoint. The existing first-use default remains seven days back. To select another starting point, open **Change checkpoint**, enter a device-local date/time, and confirm the displayed UTC instant. Moving forward skips unread messages before that time; moving backward rechecks older messages. Already imported messages remain deduplicated, queued events are untouched, and retained review messages are not automatically replayed.

Checkpoint changes compare the full `(date, rowId)` against current state. A concurrent phone sync or another editor returns a conflict and reloads the latest checkpoint rather than overwriting it. Only one active inbox-sync phone is supported.

Existing projects using `API_KEY` continue to work with their original broader permissions. Management does not rotate or revoke that key. Restricted keys continue to submit SMS even if management is later disabled. Migrating a phone to restricted credentials does not by itself revoke its legacy key; any legacy-key rotation remains an explicit operator action.

## Verify and roll back

For development:

```sh
npm ci
npm run check
npm run build
npx playwright install chromium
npm run test:web
```

The browser smoke uses temporary YAML, isolated SQLite, and a fake Actual adapter. It requires no live Actual or AI credentials. It covers authentication, private audit details, mixed Arabic/English messages, payee workflows, structured routing and bank saves, grammar editing and the parser tester, Tasker export/checkpoint behavior, mobile layouts, and logout. The integrated upstream baseline uses Node 22 and the exact Actual client pin `26.11.0`, matching the deployed server. The earlier Node 20-only cookie override is no longer needed; do not bypass package engine checks. See [runtime alignment](../MIGRATION.md#runtime-alignment-discovered-during-live-validation).

Before deploying, back up the private environment, authoritative YAML, and SQLite consistently. This change adds authentication, restricted-key, management-audit, import-execution, and identity-hold tables without replacing the existing queue schema. Execution endpoint snapshots are immutable historical matching evidence, never a live routing configuration source. Preserve `import_executions`, `import_identity_holds`, the legacy `transfer_executions`, `transfers`, and `event_import_ids` together with events and audit history. The legacy execution table is retained only as migration evidence; runtime writes and progress use the unified import table. Review current dependency advisories before exposure; retaining the pinned Actual client does not remove its inherited dependency advisories, and this change is not a general dependency-remediation project.

To disable management, remove its Compose override or set `MANAGEMENT_ENABLED=0`, `MANAGEMENT_EDIT_ACCOUNTS=0`, `MANAGEMENT_EDIT_BANKS=0`, and `MANAGEMENT_EDIT_PARSING=0`, then recreate the container. Keep the selected `CONFIG_PATH` and its mounts unchanged so the importer continues using the same YAML. Authentication tables do not need to be deleted. If rolling back to older code, restricted keys are not recognized there: update the phone deliberately to a supported credential before doing so.

Before an image downgrade, drain or reconcile pending ordinary and transfer executions. Older code does not honor their frozen plans or legacy holds; additive schema compatibility alone does not make that downgrade financially safe. Disabling management on the current image retains these engine safeguards.

Do not restore an old queue database over newer imports or delete volumes to undo UI changes. That can lose SMS, checkpoint advances, and partial-write evidence. Reverting the account file is a separate, validated operator action; the old code can load the edited account schema because this editor does not change it.
