# Tasker SMS → Actual Budget

A self-hosted Fastify service that durably queues bank SMS notifications, parses them, optionally enriches merchants, and imports transactions through Actual's official API. Bank IDs and sender aliases are configured in YAML; defaults include SAB, Al Rajhi, Wadaie, and D360.

## First-time setup

You need an Android phone with Tasker 6.6, Docker with Compose, Node.js 20+ and npm (to run the setup command), and a reachable Actual Budget server. The bundled Actual API is version 26.5.2; use a matching server version. Create your budget, accounts and categories in Actual first.

> [!WARNING]
> Upgrading your Actual server independently can break this service's startup or transaction imports. Keep the Actual server and bundled API versions aligned (currently **26.5.2**). A version mismatch only logs a warning; successful startup does not guarantee compatibility. Follow [Upgrading Actual](#upgrading-actual) when changing versions.

From this repository's directory, run `npm run setup`. No host `npm install` is required for Docker setup. Have your Actual server URL, server password, budget Sync ID (Actual **Settings → Show advanced settings → Sync ID**), and optional budget encryption password ready. The wizard reads bank choices from `config/banks.yaml` and lets you select your own existing accounts and categories; add only banks/accounts you use. Add any new bank to that file before running setup. It generates an API key for Tasker. Keep `.env` and `config/accounts.yaml` private.

Use an Actual URL reachable from **both** the setup container and the running service. Inside Docker, `localhost` refers to that container; a hostname reachable only on your host will also need a Docker host mapping (see below).

For each account, choose its bank and the identifying suffix printed in its SMS, or the balance/type rule used by that bank. These are SMS identifiers, not Actual account IDs. Example account names and suffixes are illustrative: replace them with your own, and remove unused account entries if configuring manually. The default registry retains STC Bank messages for review without importing transactions.

After starting the service, check `curl --fail http://localhost:3000/readyz` on the server. Configure an HTTPS address reachable from your phone and proxy it to the service. The default Compose port is bound to host loopback; the optional proxy network example supports a containerized reverse proxy.

Import `tasker/Actual_SMS_Inbox.prj.xml` through Tasker's project tab menu. Enter your HTTPS service base URL (no trailing slash) and the generated `API_KEY`, enable the imported profile, grant SMS permission, and apply Tasker's changes. The URL is the SMS service URL, not your Actual server URL. If import did not prompt, open the imported project's properties and set **Actual SMS service URL** and **Actual SMS API key** there. Disable battery optimization for Tasker and allow background activity. If you previously installed the immediate-forwarding project, disable or delete it before enabling inbox polling.

Run **Sync SMS Inbox To Actual Budget** once manually; the first sync reads the last seven days. Inspect **GET /v1/events** using the `X-API-Key` header and confirm the resulting transaction in Actual. `needs_review` means you should inspect the event detail. If nothing arrives, check Tasker's run log, SMS permission, HTTPS reachability and project variables. If it queues but cannot import, check service logs and your exact Actual account/category names. When changing the URL or key, update the imported project's variables on the phone too.

## Run

1. Run `npm run setup` on the host. It builds the production image and runs the CLI inside a temporary container, avoiding host-native SQLite compatibility problems. The CLI authenticates with Actual, downloads the selected budget, presents its open accounts and expense categories, and writes `.env` plus `config/accounts.yaml` back to the host. Existing setup files are never replaced unless you explicitly run `npm run setup -- --force`. `npm run setup:host` is available only when host dependencies, including Actual's native SQLite module, were installed successfully.
2. Alternatively, copy `.env.example` to `.env` and `config/accounts.example.yaml` to `config/accounts.yaml`, then fill them manually. Names must exactly match existing, open Actual accounts and categories. Each account has a `match` rule: use `accountSuffixes` for accounts identified by their SMS suffix, `transactionKinds` for a transaction type, or `hasBalance: true`/`false` when a bank uses balance presence to distinguish accounts. `OPENCODE_GO_API_KEY` is optional; LLM fallback is disabled when it is empty. `ENRICHMENT_MIN_CONFIDENCE` defaults to `0.70`, and `MAPPING_REFRESH_MINUTES` controls how often manual Actual category changes are learned.
3. Run `docker compose -f compose.example.yaml up --build -d`.
4. Put the service behind HTTPS or a trusted private reverse proxy. Check `/readyz` before sending events.

The service never creates Actual accounts or categories. It refuses to become ready if configured names are missing or ambiguous. SQLite queue data and Actual's local cache are persisted in separate volumes. Raw SMS, location, state transitions, mapping decisions, enrichment attempts, and import outcomes are retained indefinitely in SQLite for authenticated audit access. The volume is not encrypted by this service, so protect host and Docker access accordingly.

`config/accounts.yaml` and `.env` are local-only and gitignored; the tracked example files contain synthetic values. If the Actual hostname needs an explicit container-side address, copy `compose.host-override.example.yaml` to the ignored `compose.host-override.yaml`, set `ACTUAL_HOSTNAME` and `ACTUAL_HOST_IP`, and add `-f compose.host-override.yaml` to the Compose command. The setup container accepts the same Docker mapping as `ACTUAL_SMS_ACTUAL_HOST=actual.example.test:10.0.0.5 npm run setup`. To attach the service to an existing reverse-proxy network, copy `compose.proxy.example.yaml` to the ignored `compose.proxy.yaml`, optionally set `PROXY_NETWORK`, and include that file in the Compose command.

## Account routing

One bank sender can route to several Actual accounts. A rule always declares its `bank`; it then needs `accountSuffixes`, `transactionKinds`, or `hasBalance: true`/`false`. Rules must not overlap. `transferIdentifiers` is an optional, transfer-only list for destination aliases, and `billPaymentIdentifiers` maps biller codes to destination accounts; neither affects normal routing. Transfer targets are resolved across all configured banks. When a bank identifies accounts in `From`/`To` fields, configure each account's suffixes without transaction-type shortcuts so every matching transaction routes by its source or destination account. Al Rajhi credit-card SMS with a numeric balance can route separately from checking SMS without one. Tasker sends the full message and requires no routing changes.

SMS parsing uses one shared English/Arabic grammar for every supported bank. A separate source resolver identifies the `bank` metadata used by account routing, but does not select a bank-specific parser. Transaction markers and field extractors live in `config/parsing.yaml`; the shared TypeScript engine converts extracted values and applies accounting semantics such as direction and signs. Account numbers and Actual mappings remain configuration, while self-transfer detection remains part of routing and processing.

### Adding a bank

Edit the tracked registry `config/banks.yaml` to add a bank ID and its SMS sender aliases. The same registry drives the setup wizard, inbox filtering, and parsing. For example, append this entry under `banks`:

```yaml
- id: example-bank
  name: Example Bank
  senders: [ExampleBank, Example Bank]
  disposition: import
```

Then add an account route in your local `config/accounts.yaml`, using an existing Actual account name and the suffix printed in your SMS:

```yaml
accounts:
  - actualName: Example Checking
    match:
      bank: example-bank
      accountSuffixes: ['1234']
```

`senders` match the complete sender, ignoring case and extra whitespace; aliases are literal text, not regular expressions or substring patterns. List each spelling your phone receives. Optional `messageAliases` identify a bank only for legacy requests without a sender; matches require word boundaries, and messages matching multiple banks are retained for review. `disposition` defaults to `import`; set it to `needs_review` to retain that bank's messages without importing them or offering it in setup.

IDs must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens. Keep existing IDs stable: account routing and transaction deduplication use them. Startup rejects duplicate IDs or aliases, unknown account bank IDs, and account routes for review-only banks.

Restart the service after changing configuration. The example Compose file mounts the registry at `/config/banks.yaml`; `BANKS_CONFIG_PATH` can select another container-side path if you also mount it there. Existing deployments must add this registry mount when upgrading; existing account mappings need no changes. For host development, point `BANKS_CONFIG_PATH` to `config/banks.yaml`. Setup reads the repository's `config/banks.yaml` by default.

Adding a bank whose messages fit the shared grammar requires only YAML changes. New transaction wording or field labels can be configured through message templates described below. Unrecognized or malformed messages from registered import banks are retained for review. After enabling a new sender, run **Reconcile Inbox Last 7 Days** to recover recently skipped messages. Already-retained review events are not automatically retried merely by changing bank configuration.

### Custom SMS templates

`config/parsing.yaml` contains the shared English/Arabic defaults and optional `templates`. Each bank in `config/banks.yaml` can reference template IDs with `templates: [example-purchase]`. All banks use the same parser engine.

Append a template under the parser file's `templates` list, for example:

```yaml
- id: example-purchase
  match:
    - source: 'Statement debit'
      flags: i
  kind: purchase
  fields:
    principal:
      - source: 'Paid SAR (?<value>[0-9.]+)'
        flags: u
  required: [principal, accountAlias]
```

Patterns run against normalized SMS text (Arabic digits converted, thousands separators removed, whitespace collapsed). Use single-quoted YAML regex strings to preserve backslashes. Flags may contain `i`, `m`, `s`, and `u` once each; the engine controls repeated matching. Scalar extractors must capture `value`; `foreign` captures `amount` and `currency`. All pattern lists are ordered. The shared classifier retains its specific-before-generic order.

Supported fields are `accountAlias`, `accountAliases`, `from`, `to`, `iban`, `beneficiary`, `biller`, `merchant`, `principal`, `total`, `fee`, `balance`, `foreign`, `date`, `sarEquivalent`, and the boolean `cashback` marker. Date interpretation retains the existing supported formats, Riyadh timezone, and received-time fallback. Amount fields describe SAR amounts; foreign amounts are kept separately. No arbitrary conversion code or accounting formulas run from YAML.

Ignored notifications and review-only banks are handled before templates. Exactly one matching template selects its transaction kind and field overrides. Omitted fields inherit shared extractors; an overridden field that does not match stays absent, with no fallback. Missing or invalid required fields produce `needs_review`. Multiple matching templates produce `needs_review` with `ambiguous_template`. No matching template uses the shared grammar. Purchases, refunds, transfers, fees, and account routing retain the same shared accounting logic.

Restart after edits. Compose mounts the parser file at `/config/parsing.yaml`; add this mount to existing deployments. `PARSING_CONFIG_PATH` selects its location (use `config/parsing.yaml` for host development). Setup validates this file and bank template references before writing configuration. Startup rejects invalid versions, fields, flags, regexes, captures, and references rather than falling back to hidden defaults. Bank and parser configuration must be deployed together.

The parser revision is now 15 for the account-reference and transfer-identity corrections. Normal parser-revision replay safeguards still apply; imported events are never replayed. Later YAML edits alone do not trigger historical replay. Test new templates with representative and negative SMS examples before deployment.

The client is pinned exactly to `@actual-app/api` 26.5.2 to match the deployed Actual server. Startup logs both versions. A mismatch or a failure to discover the server version emits a warning but does not prevent readiness; authentication, budget download, and migration failures remain fatal. The image stays on Node 20, which API 26.5.2 supports, and runs as the non-root `node` user with writable `/data` and `/actual-cache` mount points.

D360 routes use `bank: d360` and the card suffix in the SMS. Set `actualName` to the exact existing Actual account name before deployment. International purchases such as `JPY 878.00 (SAR 20.91)` import the SAR equivalent plus any separately reported fee and retain the foreign amount in notes. Yen alone is never treated as SAR. After deployment, run **Reconcile Inbox Last 7 Days** to recover D360 messages previously skipped as unsupported.

## Event status and review

Statuses are `queued`, `processing`, `imported`, `imported_review`, `ignored`, `needs_review`, and `failed`. OTP, login, declined, and insufficient-funds notifications are intentionally ignored. Unknown or malformed templates from registered banks and messages from review-only banks are retained as `needs_review`; they do not create an Actual transaction or retry within the current parser revision. `GET /v1/events/:id` includes the original input, complete transition history, enrichment attempts, mapping provenance, the safe `parserReason`, and operational `error` values. `GET /v1/events` provides cursor-paginated summaries with optional `status`, `enrichmentStatus`, `from`, and `to` filters; raw SMS and location appear only in the authenticated detail response. Processing retries use 1 minute, 5 minute, 30 minute, and 2 hour delays; terminal errors stay queryable.

On startup, each parser revision requeues retained ignored and needs-review notifications from an earlier parser revision once. Events already imported are never replayed. This lets a corrected template import an older missed transaction while Actual's stable import ID prevents duplicates.

## Inbox polling (Tasker)

The Tasker 6.6 project at `tasker/Actual_SMS_Inbox.prj.xml` reads the Android SMS database (`content://sms/inbox`) every 5 minutes and uploads everything new, so notifications missed while Tasker is killed, the screen is off, or the device was offline are recovered on the next poll. Copy it to the phone, open Tasker, long-press the project tabs at the bottom, choose **Import Project**, and select the XML file. Enter the service's public HTTPS base URL without a trailing slash and the `API_KEY` value from `.env`, enable the profile, and grant Tasker SMS permission. Exclude Tasker from battery optimization and allow background activity. Deploy a service version supporting `/v1/inbox-sync` before importing this project.

The durable `(date, _id)` checkpoint now belongs to the server, not Tasker. Each task execution fetches it from `POST /v1/inbox-sync/start`, reads all inbox rows after it without a sender filter, and sends batches of 25 oldest-first to `POST /v1/inbox-sync/batch`. Tasker sends the content-provider identifier fields verbatim; the server normalizes and validates them atomically with the checkpoint update. It classifies senders using `config/banks.yaml`, queues import-bank notifications, retains review-only bank messages for review, discards unknown senders or empty messages without storing their content, and advances through every acknowledged row in the same SQLite transaction. One task execution drains at most 10 batches (250 messages); a later poll resumes from the server checkpoint.

On first use, the server initializes the checkpoint seven days in the past. Existing events remain safe because the endpoint preserves `inbox-v2-<date>-<row _id>` IDs and deduplicates the migration replay. The old `%ActualSmsInboxV2*` Tasker globals are ignored and may be deleted. This protocol supports one active inbox-sync phone; disable the old phone before moving the project to another one.

- Every inbox SMS after the checkpoint transits the private HTTPS service. Unsupported content is classified in memory and is not written to the event database. Protect the endpoint and API key accordingly.
- `receivedAt` comes from the inbox `date` column. Location is unavailable during polling and is omitted.
- The client includes its expected checkpoint in each batch. A concurrent run or rewind produces `409 checkpoint_conflict`, so Tasker stops and fetches the authoritative checkpoint next time instead of skipping rows.
- Empty SMS bodies are acknowledged as `empty`, unsupported senders as `unsupported`, existing event IDs as `duplicate`, and new bank events as `queued`. Every valid row advances the checkpoint.
- Network errors and malformed responses require no local recovery state. If the server committed the batch, the next start call sees the advanced checkpoint; otherwise it returns the prior checkpoint.

The imported project also contains **Reconcile Inbox Last 7 Days**. Wait for an active sync to finish, run it to move the server checkpoint backward by seven days, and let the next poll replay that window safely. Reconciliation is idempotent: if the checkpoint is already farther back than the rolling seven-day boundary, it succeeds without moving it forward. The sync route has a 5 MiB body limit and accepts at most 25 rows per batch. The Tasker SQL Query uses the visible `|~sms~|` column divider. The server also recovers unsplit comma-separated rows sent by older imports whose tab divider was lost, preserving commas and newlines inside SMS bodies.

## Privacy and accounting behavior

Before calling OpenCode Go, the service checks an exact normalized merchant-plus-Actual-account mapping learned from categorized Actual transactions, manual corrections, and prior successful SMS enrichments. Actual history refreshes at startup and hourly by default. A hit reuses the prior payee/category without an LLM request; any active expense category may be reused. Only a miss invokes the best-effort LLM fallback.

Only normalized merchant text, optional exact location/time context, and configured eligible category IDs/names are sent to OpenCode Go. Raw SMS, balances, account suffixes, aliases, and unrelated personal data are not included. The service uses OpenCode's OpenAI-compatible Chat Completions endpoint in JSON-only mode and validates every response locally. It defaults to `deepseek-v4-flash`; set `OPENCODE_GO_MODEL` to change it. Enrichment is model-only and does not use web search. Provider failure, invalid output, quota exhaustion, rate limits, and timeouts never block a valid import. Categories are applied at confidence 0.70 or above by default; lower-confidence suggestions may normalize the payee but do not set a category. Sanitized request, response, timing, outcome, and failure details are retained in the event audit.

Actual rules remain authoritative. Imports are cleared, deduplicated by stable `imported_id`, retain Actual's default behavior of not reimporting deleted entries, and sync after writes. Foreign-only messages use chronological balance deltas when safe; otherwise a zero-value `REVIEW REQUIRED` transaction is imported.

## Development

```sh
npm install
npm test
npm run typecheck
```

Code style is enforced with Prettier and ESLint. Run `npm run format` to apply formatting, `npm run lint:fix` for safe lint fixes, or `npm run check` to run formatting, lint, type checking, and tests together.

## License

MIT. See `LICENSE`.

### Disposable Actual smoke test

The live smoke test is destructive and refuses to run unless `LIVE_ACTUAL_TEST=1`. Use only a separate disposable budget with a uniquely named test account. It creates a uniquely identified zero-value transaction, verifies it after sync, deletes it, and syncs again. If cleanup fails, the command exits nonzero and prints the identifier for manual removal.

```sh
LIVE_ACTUAL_TEST=1 \
ACTUAL_SERVER_URL=https://actual.example.test \
ACTUAL_SMOKE_SYNC_ID=disposable-budget-sync-id \
ACTUAL_SMOKE_PASSWORD=server-password \
ACTUAL_SMOKE_ENCRYPTION_PASSWORD=optional-budget-password \
ACTUAL_SMOKE_CACHE_DIR=/tmp/actual-sms-smoke-cache \
ACTUAL_SMOKE_ACCOUNT_NAME='SMS Smoke Test' \
npm run smoke:actual
```

`ACTUAL_SMOKE_ENCRYPTION_PASSWORD` is optional; all other variables shown are required. These smoke-only credentials do not change production startup configuration. Normal tests never contact Actual or OpenCode. Set `LIVE_OPENCODE_GO_TEST=1` together with an explicit `OPENCODE_GO_API_KEY` to run the opt-in OpenCode Go smoke test.

### Upgrading Actual

Upgrade the Actual server first. Then set `@actual-app/api` to that exact server version (without `^` or `~`), regenerate `package-lock.json`, run `npm run check` and `npm run build`, rebuild the image, and run the disposable smoke test before deployment. Do not ignore `out-of-sync-migrations`: it means the API client must be upgraded to a version containing the server's migrations. The remaining moderate advisory inherited through `@actual-app/crdt` is accepted while compatibility requires the 26.5.2 pin.
