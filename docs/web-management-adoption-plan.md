# Narrow web management adoption plan

Status: phases 1–5 implemented on `feat/narrow-web-management`; phase 6 remains gated and manual approval is disabled.

Audience: maintainers implementing and reviewing the adoption. This document records the agreed design and acceptance criteria; see [Browser management](management.md) for implemented deployment and operation instructions. The implementation uses a small TypeScript browser application and locally provisioned password/session credentials rather than public owner registration. Fastify is updated within major version 5 to address published HTTP/authentication advisories. The original adoption targeted Node 20 / Actual API 26.5.2; this branch now integrates the independently upgraded upstream Node 22 / exact Actual API 26.11.0 baseline. See [runtime alignment](../MIGRATION.md#runtime-alignment-discovered-during-live-validation).

## Objective

Adopt a small web management layer inspired by [almar37/sms2actual](https://github.com/almar37/sms2actual), without importing its second configuration authority, duplicate parsing/accounting implementation, or financial dashboard scope.

> The browser manages the existing importer. It does not become another engine or another source of configuration truth.

The comparison baseline is upstream `0f80d1b` and fork `1081055`. Their histories have no common ancestor. Use the fork as a reference for selected workflows, not as a branch to merge wholesale. Preserve attribution for any copied implementation or assets.

## 1. Scope and invariants

### Included

- Consistent Actual import-error handling and transaction-ID recording for transfers.
- Offset-preserving conversion of transaction timestamps to Actual calendar dates.
- Controlled pause, reconnection, configuration activation, and shutdown.
- Authenticated operational status and read-only SMS audit views.
- Browser account-routing edits that update the existing YAML file.
- Restricted Tasker credentials, configured project export, and explicit checkpoint selection.
- Manual review and approval, only after its separate engine-design gate passes.

### Excluded

- All fork-specific Al Rajhi YAML additions, bank-template references, and supporting recognition changes. Existing upstream Al Rajhi support remains untouched.
- Credit limits, utilization, holdings, account-balance dashboards, and recent Actual transaction feeds.
- A second browser-template language or browser-specific normalization/accounting rules.
- Automatic repayment-funding assumptions and new transaction kinds.
- Additional AI providers or changes to the existing provider/model defaults.
- Storage of unsupported-sender inbox messages.
- Hard reset, bulk deletion, and automatic historical replay after configuration edits.
- Browser editing of Actual credentials, arbitrary environment variables, or filesystem paths.
- A separate merchant-rule editor or other unapproved management features.
- Unrelated formatting, renaming, repository-guidance removal, or toolchain upgrades.

### Required invariants

1. **Files remain authoritative.** `CONFIG_PATH`, `BANKS_CONFIG_PATH`, and `PARSING_CONFIG_PATH` identify the account, bank, and parsing YAML. Connection credentials and runtime settings retain their existing environment-based ownership. SQLite must not shadow these values.
2. **There is one engine.** Automatic processing and any later approved review submissions use the same account resolution, accounting, transfer matching, enrichment policy, import-ID generation, and Actual write implementation.
3. **The core has no web dependency.** `Processor`, the parser, and routing must not import management modules, inspect authentication tables, or query browser override/settings tables.
4. **Existing behavior remains the baseline.** Preserve routing expressiveness, fee policy, foreign-amount handling, retries, deduplication, parser-revision behavior, and Actual's treatment of deleted imports unless a separately reviewed change explicitly says otherwise.
5. **Privacy does not depend on UI enablement.** Unsupported-sender inbox content is still discarded. Raw SMS and location remain restricted to authenticated detail views, not summary lists or logs.
6. **Actual objects already exist.** Accounts and categories must resolve to existing valid objects; the service never creates them. Startup configuration errors, including missing or ambiguous configured names, remain hard failures rather than silently dropping mappings.
7. **The web layer is optional.** Existing CLI/environment/YAML deployments and ingestion routes continue to work without browser setup or writable configuration.
8. **Compatibility changes stay separate.** Preserve the integrated upstream Node 22 / exact `@actual-app/api` pin at `26.11.0` for this adoption. The original `26.5.2` target was superseded by the separately documented upstream runtime alignment, not by management functionality. Further runtime or dependency upgrades need their own justification, compatibility checks, and review.

## 2. Ownership and module responsibilities

These are responsibilities, not a requirement to create one file or abstraction per row. Keep interfaces small and introduce seams only where behavior actually varies.

| Module                              | Responsibility                                                                                                    | Must not own                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Configuration validation/resolution | Parse YAML, validate rules and references, resolve Actual names, produce a complete runtime snapshot              | Browser sessions or a second configuration schema                                  |
| Configuration file editor           | Read allowed files, detect stale edits, preserve YAML structure, validate and atomically replace an editable file | Routing/accounting policy or SQLite configuration precedence                       |
| Runtime coordinator                 | Control queue claims, drain active work, activate snapshots, reconnect the Actual session, report readiness       | SMS recognition or browser-specific state                                          |
| Existing engine                     | Parse, route, enrich, account, import, deduplicate, and audit                                                     | HTTP requests, sessions, display-only observations                                 |
| Management HTTP modules             | Authenticate and translate bounded requests into application operations                                           | Direct Actual writes, raw SQL, or independent transaction construction             |
| Browser application                 | Display typed responses, collect edits, show validation/conflict/pending states                                   | Secrets in browser storage or authoritative financial calculations                 |
| Review module, later                | Persist validated approval intent and submit it through the shared engine                                         | A parallel import path or a generic transaction-override table read by `Processor` |

`src/main.ts` remains the composition point. Reuse or extract validation currently in `src/config.ts`, `src/parsing/config.ts`, and startup name resolution; do not reproduce it in HTTP handlers. Expose bounded audit reads through the existing store rather than teaching handlers its table layout.

The runtime snapshot is an in-memory, derived representation of files, not another persisted configuration authority. UI and headless operation must use the same lifecycle and validation interfaces.

## 3. Delivery sequence

Each phase is independently reviewable and deployable. Do not start with a copy of the fork's `console.ts`, `ConsoleConfig`, or modified processor and then remove unwanted behavior.

### Phase 1: independent engine safeguards

**Work**

- In `src/processor.ts`, consistently inspect Actual import results for ordinary transactions, linked transfers, unlinked transfers, and transfer fees.
- Record returned principal transaction IDs for transfer imports where available. Persist evidence of partial success before reporting an error; do not assume a result containing errors made no changes.
- Preserve the timestamp's offset when deriving the Actual date, without changing the inputs to existing stable import IDs.
- Leave transfer principal/fee amounts, categories, matching rules, and bank grammar unchanged.

**Tests**

- Success and rejection in each import branch, including principal success followed by fee failure.
- Partial results containing both transaction IDs and errors; network failure and sync failure after a write.
- Retrying a partially completed transfer reuses the same principal/fee IDs and does not prematurely mark the event imported or record a completed match.
- Dates around Riyadh midnight on a UTC host, plus explicit offsets crossing the host's calendar day.
- Historical import-ID fixtures remain unchanged; existing imported events are not replayed.

**Acceptance**

These patches require no web dependencies or configuration migration. Existing parser fixtures and routing/fee expectations remain unchanged. The date fix is not an excuse to replay historical imports or increment the parser revision mechanically.

### Phase 2: controlled runtime lifecycle

**Work**

- Extract the existing startup configuration resolution into a reusable operation.
- Introduce a runtime coordinator with a small interface for status, reconnecting the configured Actual session, and activating a validated configuration.
- Before replacing the session or active configuration, block new queue claims and mapping refreshes, then wait for active processing and existing refreshes to finish.
- Use the same coordination for timer-triggered work, ingestion-triggered ticks, management actions, and shutdown. Avoid multiple booleans scattered across handlers.
- Allow management access during recoverable connection outages, once the management layer exists. Continue accepting supported SMS into the durable queue when safe, without consuming retry attempts merely because imports are paused.
- Keep missing configuration and invalid startup mappings as explicit startup failures. A recoverable connection outage is not permission to accept invalid routing or create an empty configuration silently.
- Reconnect using the configured environment credentials. Changing those credentials still requires the existing deployment/restart workflow. Do not support switching budgets through the browser.

**Readiness contract**

- `/healthz`: the process can answer requests.
- `/readyz`: configuration is resolved, an Actual session is initialized, and the importer is not paused, reconnecting, or shutting down.
- Authenticated management status: detailed state and sanitized recovery errors.

Readiness is not a promise that every future import will succeed, nor does it introduce a stricter version-mismatch policy than upstream currently has. An available login page alone never makes `/readyz` healthy.

**Tests and acceptance**

Use a fake Actual adapter and controllable promises to verify draining, rejection/serialization of concurrent reconnects, blocked queue claims, mapping-refresh coordination, readiness transitions, shutdown races, and recovery without duplicates. Never shut down an adapter while it has an active operation. Keep the existing startup validation tests and add coverage distinguishing configuration errors from recoverable connection errors.

### Phase 3: authenticated read-only management

**Work**

- Add an optional browser application containing importer status, queue/status counts, a cursor-paginated event list, and authenticated event details/history/enrichment outcomes.
- Use shared, typed response contracts. Do not copy the fork's widespread untyped browser data or add dashboard-specific methods to `ActualAdapter`.
- Separate management authentication/routes from ingestion authentication. Browser sessions may call management routes; they do not automatically authorize `/v1` routes. The existing API key must not automatically authorize management operations.
- Use a maintained authentication implementation, with an explicitly reviewed dependency/runtime footprint. Avoid designing password hashing or sessions from scratch. If using Svelte, adopt only the required UI/build tooling and useful workflow presentation, not the fork's backend settings model.
- Require a local bootstrap procedure or explicit one-time setup credential. Do not expose unauthenticated first-owner registration that relies solely on winning a race after deployment.
- Protect sessions with appropriate cookies, expiry, revocation, exact trusted origins, CSRF protection, login throttling, response security headers, and no-store responses for sensitive data.
- Redact passwords, cookies, session/Tasker credentials, raw SMS, and location from application logs. Define reverse-proxy trust explicitly; do not trust arbitrary forwarded IP headers for authentication throttling.

Authentication/session records may be stored in SQLite; they are not application configuration. Any new signing secret is explicit, persistent, and privately provisioned rather than silently derived from an ingestion key. Disabling management requires no owner registration and no management-only secret.

**Tests and acceptance**

Test missing/expired sessions, setup protection, origin/CSRF failures, escaped SMS content, throttling, redaction, pagination, and authorization separation. Browser smoke tests use isolated SQLite and a fake Actual adapter. The existing ingestion suite passes with management both disabled and enabled, including identical unsupported-sender discard behavior and summary/detail privacy.

This phase ships without write actions. Do not add a permanent browser refresh loop that downloads budgets or transaction histories.

### Phase 4: YAML-backed account editor

**Work**

- Edit only the account configuration at `CONFIG_PATH` in the first release. Bank/parser YAML remains readable, with browser editing deferred to a separate extension of the same file-editing mechanism.
- Model a list of routing rules, not one browser object per Actual account. Preserve multiple non-overlapping rules for one Actual account, transaction-kind and balance predicates, suffixes, transfer identifiers, and bill-payment identifiers.
- Serialize the existing name-based YAML schema. Actual IDs may identify selection options in a response but must not replace configured account/category names with a database-owned routing format.
- Provide validation errors and a diff before confirmation. Use the exact same validation/resolution operation as startup and configuration activation.
- Preserve comments, ordering, unrelated fields, and semantically meaningful list order through the YAML document representation. Reject unsupported constructs or unknown fields that cannot be preserved safely rather than stripping them through schema parsing or a form round trip.

**Save and activation protocol**

1. Read the configured file and return a content revision plus the active configuration revision. A composite revision includes every configuration file used in validation.
2. Submit a candidate and the revision the owner edited. Reject stale content with a conflict and leave files untouched.
3. Parse and resolve a complete candidate snapshot, including bank/parser references and Actual name checks. Actual being unavailable blocks semantic validation; it does not permit a best-effort save.
4. Acquire the configuration-operation lock, pause imports/refreshes, drain active work, and recheck the candidate's file and runtime dependencies before committing.
5. Write a temporary file in the same directory, preserve appropriate ownership/permissions, flush it, and rename it atomically. Never truncate the live file in place.
6. Activate the already validated snapshot as one coordinated change. Do not expose partially mutated account lists to the processor or a different bank configuration to ingestion.
7. Return the persisted and active revisions explicitly. A disk-only save is pending, not an active success.

Filesystem writes and in-memory activation are not one transaction. On uncertain write/activation failure, keep imports paused and expose the disk/active mismatch until validated recovery. If the process stops after rename but before activation, restart validates and loads the authoritative files. Do not restore an old file automatically over a possible external edit.

Keep a protected previous file or equivalent operator recovery copy before replacement; it is a backup, never an alternative runtime configuration source. File-save audit entries record actor, outcome, and revisions, not unrestricted copies of private configuration.

**External edits and concurrency**

External edits retain their existing restart-based behavior. Add an explicit reload operation using the same validation/activation path; an invalid external edit cannot silently become active. Do not introduce automatic file watching in this phase. Display detected saved/active differences rather than claiming a stale snapshot matches disk.

Revision checks detect observed external changes but cannot lock arbitrary editors. Serialize application writes, recheck immediately before replacement, and document that external editors must not write concurrently with a browser save. Do not claim general filesystem compare-and-swap guarantees. If that operational constraint is unacceptable, require a shared writer protocol before enabling edits.

**Mount and path constraints**

- Preserve existing read-only, single-file mounts as the default. Show a read-only editor when writes are disabled or unavailable.
- Offer an explicit editing deployment example using an appropriately owned writable configuration directory; atomic rename does not work reliably by replacing a single bind-mounted file.
- Account editing needs only `CONFIG_PATH`. Do not grant write access to other configuration files merely to make the UI work; mount them separately read-only or place the account file in a dedicated editable directory.
- Allowlist configured paths server-side. Reject path traversal and unexpected symlink targets. No browser-supplied target paths, repository-root mounts, or Docker socket access.
- Do not copy YAML into SQLite or silently relocate it into an internal managed directory.

**Tests and acceptance**

Use temporary directories for comment/field-preserving round trips, advanced routing rules, duplicate-name failures, unknown/review-only banks, read-only mounts, stale edits, invalid dependencies, permission/write/rename failures, interrupted activation, and restart recovery. Exercise save-versus-processing and save-versus-reconnect races.

Acceptance requires that a browser edit produces the same resolved configuration as an equivalent manual YAML edit followed by restart. A fresh process uses the edited files without any saved browser settings. No account editor is released until pending/failure states and writable-directory deployment are covered.

Bank/parser editing is not part of this phase. Adding it later requires shared grammar validation, unchanged ignored-message precedence, and an explicit multi-file persistence/recovery design for bank-template references. It does not authorize importing the fork's Al Rajhi grammar or adding browser-only templates.

### Phase 5: Tasker management

**Work**

- Generate a configured download from `tasker/Actual_SMS_Inbox.prj.xml`; do not maintain a second hand-edited project or introduce route aliases solely to match the fork.
- Validate the public HTTPS base URL and safely encode XML values. Treat exports and credential reveals as sensitive, no-store responses.
- Add a separate restricted Tasker credential, stored privately with appropriate server-side verification. Permit only the SMS submission and inbox-sync routes it needs; deny event-history reads, configuration edits, and session operations.
- Preserve the existing `API_KEY` contract for current phones and operators. Enabling management must not rotate it or silently revoke existing clients. Document that a legacy key remains broader until an operator explicitly migrates the phone.
- Make new-credential rotation explicit. Show that re-export/re-import is needed, without exposing either credential in audit logs or URLs.
- Add checkpoint inspection and an explicit change operation that compares the full expected `(date, rowId)` against current state in one store transaction, including the uninitialized state.
- Reject future/invalid times, explain forward-skip/backward-recheck consequences, preserve the selected instant across browser time zones, and return the latest checkpoint on conflicts.

Preserve the initial seven-day lookback, inbox event IDs, atomic batch/checkpoint commit, and single-active-phone assumption. Viewing the page, exporting a project, or rotating a credential must not initialize or move the checkpoint. Selecting an earlier checkpoint does not automatically reprocess retained review events.

**Tests and acceptance**

Test URL/XML encoding, restricted-key scope, explicit rotation, old-client compatibility, checkpoint persistence on restart, uninitialized/stale checkpoint edits, time zones, concurrent phone batches, and replay deduplication. Browser smoke tests verify export and confirmation flows; test the generated XML's existing task names, routes, and variable substitutions without requiring a live phone.

### Phase 6: manual review, behind a design gate

Do not implement this by copying the fork's transaction overrides. The read-only audit view can remain a complete release while this phase is designed.

**Required design before implementation**

- A UI-independent review intent with explicit validation, lifecycle, and durable storage. Store human decisions as audit/workflow data, not account configuration.
- One shared transaction-planning/import implementation for parser results and approved review intent. Extract only the existing behavior needed at this seam, protected by characterization tests; do not build a generic rules framework or broaden bank recognition.
- An explicit eligibility rule: initially only `needs_review` events with no Actual write attempt. Exclude ignored messages, active processing, imported/imported-review events, and failed or ambiguous partial imports. Editing completed transactions remains an Actual operation.
- An explicit human action for a retained review-only-bank message, distinct from enabling automatic imports for that bank. Automatic ignored/review-only precedence remains unchanged.
- A durable dispatch/identity design covering success, partial success, response loss, retries, crashes, and concurrent approvals. A missing returned Actual ID alone is not proof that no write happened. Preserve existing automatic import IDs and freeze the approved submission's identities and decision before dispatch.
- A documented accounting contract for supported review fields, fees, transfers, categories, notes, dates, and foreign amounts. UI preview and execution must agree. Do not add external-transfer fee/categorization policies or repayment defaults implicitly.

If a safe shared implementation cannot be introduced narrowly, stop at read-only review rather than add a parallel engine.

**Implementation constraints**

HTTP handlers submit review intent; they never construct final Actual transactions or call import methods. Persistence belongs behind review/store operations, not SQL in routes or processor inspection of console tables. The engine receives validated domain input through its shared execution interface, not a browser-specific configuration object.

Validate open Actual objects, integer monetary ranges, date offsets, transfer identity, and account/category compatibility. Do not infer missing funding accounts, reuse a different parsing language, or train persistent merchant rules as a hidden side effect of approval. Suggestions, if provided, come from existing shared extractors and never authorize an import on their own.

**Tests and acceptance**

Compare parser-generated and review-generated equivalent inputs through the same accounting/import tests. Cover principal/fee totals, foreign review, transfer matching, ignored-message exclusion, review-only banks, stale submissions, concurrent approval/claims, partial/unknown writes, retries, crash recovery, and immutable historical import IDs.

A browser refresh or repeated approval must never create another Actual transaction. The same review interface must be testable without HTTP, and management-disabled processing must not import a web module. Approve this design separately before enabling review writes.

## 4. Verification and review gates

For every phase:

1. Add focused regression/failure-path tests before treating the implementation as complete.
2. Run `npm run check` in its existing order: formatting, zero-warning lint, typecheck, tests.
3. Run `npm run build`. Once a browser exists, include its type/lint checks and build without weakening existing strictness.
4. For browser changes, run an isolated browser smoke suite with fake Actual and no live AI calls. Cover authentication, read-only operation, forms/conflicts, and the relevant write workflow.
5. Verify existing deployments with management disabled, management enabled with read-only YAML, and explicitly enabled YAML editing. Exercise lifecycle and checkpoint behavior in each applicable mode.
6. Use live Actual testing only with the existing explicit opt-in and a disposable budget. Never use production credentials or live imports to validate this plan by default.
7. Review the diff for accidental bank grammar changes, API/version changes, personal deployment data, new configuration precedence, and unrelated formatting churn.

Release stops if enabling the UI changes recognition, imported amounts, fee categories, stable import IDs, unsupported-sender retention, or initial inbox lookback beyond an explicitly approved change. No live smoke test substitutes for the deterministic regression suite.

## 5. Deployment, rollout, and rollback

- Ship engine safeguards before the optional UI. Ship read-only management before editing, and account editing before manual approval.
- Keep existing setup/Compose instructions valid. Add opt-in management/editing instructions, not a forced migration to browser onboarding.
- Document management enablement, bootstrap secrets, allowed origins, reverse-proxy trust, configuration permissions, backups, and the persisted/active revision distinction before exposing management publicly.
- Use additive, versioned database migrations for authentication, restricted credentials, configuration audit, and later review workflow. Do not repurpose existing event columns as console state or require importing the fork's database.
- Before deployment, take a consistent SQLite backup, configuration/environment backup, and a compatible Actual-cache backup if needed. Protect all copies as private data. Record the image revision and schema compatibility.
- Disabling management should leave ingestion and processing running with the same YAML and environment. Revocation and outstanding approved work need explicit handling; do not silently delete audit or credential records.
- Roll back code only after checking schema compatibility. YAML editing initially preserves the existing schema so the old importer can load the edited file. Restore a previous YAML copy only as a deliberate, validated operator action.
- Before disabling or rolling back manual approval, drain or explicitly hold approved submissions under a documented compatible workflow. An older engine must not misinterpret approved work as ordinary parser input.
- Never restore a pre-deployment queue database over newer imports without reconciliation: doing so can lose queued SMS, checkpoint advances, approval identities, and evidence of partial writes. Do not delete volumes, replay imported events, or re-import deleted Actual transactions as a rollback shortcut.

## 6. Definition of done

The adoption is complete only when:

- Management can be disabled without losing the importer's existing CLI/environment/YAML operation.
- Browser-edited account YAML survives restart and is the only persisted routing authority.
- Core processing contains no web imports, browser-table queries, credit-limit observations, or second template engine.
- Existing routing expressiveness and bank support are preserved; no fork Al Rajhi recognition changes were introduced.
- Shared accounting/import tests demonstrate unchanged automatic behavior except the narrowly approved safeguards.
- Security, filesystem failure, concurrency, partial-write, and rollback cases are covered for every enabled write workflow.
- Documentation describes actual implemented behavior and does not promise privacy or readiness properties the implementation violates.

Manual approval is an independently gated final phase, not a prerequisite for releasing the useful read-only management layer.
