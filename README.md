# Tasker SMS → Actual Budget

A self-hosted Fastify service that durably queues SAB and Al Rajhi SMS notifications, parses them, optionally enriches merchants, and imports transactions through Actual's official API.

## Run

1. Run `npm run setup` on the host. It builds the production image and runs the CLI inside a temporary container, avoiding host-native SQLite compatibility problems. The CLI authenticates with Actual, downloads the selected budget, presents its open accounts and expense categories, and writes `.env` plus `config/accounts.yaml` back to the host. Existing setup files are never replaced unless you explicitly run `npm run setup -- --force`. `npm run setup:host` is available only when host dependencies, including Actual's native SQLite module, were installed successfully.
2. Alternatively, copy `.env.example` to `.env` and `config/accounts.example.yaml` to `config/accounts.yaml`, then fill them manually. Names must exactly match existing, open Actual accounts and categories. Each account has a `match` rule: use `accountSuffixes` for accounts identified by their SMS suffix, `transactionKinds` for a transaction type, or `hasBalance: true`/`false` when a bank uses balance presence to distinguish accounts. `OPENCODE_GO_API_KEY` is optional; LLM fallback is disabled when it is empty. `ENRICHMENT_MIN_CONFIDENCE` defaults to `0.70`, and `MAPPING_REFRESH_MINUTES` controls how often manual Actual category changes are learned.
3. Run `docker compose -f compose.example.yaml up --build -d`.
4. Put the service behind HTTPS or a trusted private reverse proxy. Check `/readyz` before sending events.

The service never creates Actual accounts or categories. It refuses to become ready if configured names are missing or ambiguous. SQLite queue data and Actual's local cache are persisted in separate volumes. Raw SMS, location, state transitions, mapping decisions, enrichment attempts, and import outcomes are retained indefinitely in SQLite for authenticated audit access. The volume is not encrypted by this service, so protect host and Docker access accordingly.

`config/accounts.yaml` and `.env` are local-only and gitignored; the tracked example files contain synthetic values. If the Actual hostname needs an explicit container-side address, copy `compose.host-override.example.yaml` to the ignored `compose.host-override.yaml`, set `ACTUAL_HOSTNAME` and `ACTUAL_HOST_IP`, and add `-f compose.host-override.yaml` to the Compose command. The setup container accepts the same Docker mapping as `ACTUAL_SMS_ACTUAL_HOST=actual.example.test:10.0.0.5 npm run setup`. To attach the service to an existing reverse-proxy network, copy `compose.proxy.example.yaml` to the ignored `compose.proxy.yaml`, optionally set `PROXY_NETWORK`, and include that file in the Compose command.

## Account routing

One bank sender can route to several Actual accounts. A rule always declares its `bank`; it then needs `accountSuffixes`, `transactionKinds`, or `hasBalance: true`/`false`. Rules must not overlap. `transferIdentifiers` is an optional, transfer-only list for destination aliases, and `billPaymentIdentifiers` maps biller codes to destination accounts; neither affects normal routing. Transfer targets are resolved across both banks. When a bank identifies accounts in `From`/`To` fields, configure each account's suffixes without transaction-type shortcuts so every matching transaction routes by its source or destination account. Al Rajhi credit-card SMS with a numeric balance can route separately from checking SMS without one. Tasker sends the full message and requires no routing changes.

SMS parsing uses one shared English/Arabic grammar for every supported bank. A separate source resolver identifies the `bank` metadata used by account routing, but does not select a bank-specific parser. Transaction markers and field labels live in the grammar catalog, generic extractors handle amounts, dates, aliases, and names, and the parser applies accounting semantics such as direction and signs. Account numbers and Actual mappings remain configuration, while self-transfer detection remains part of routing and processing.

The client is pinned exactly to `@actual-app/api` 26.5.2 to match the deployed Actual server. Startup logs both versions. A mismatch or a failure to discover the server version emits a warning but does not prevent readiness; authentication, budget download, and migration failures remain fatal. The image stays on Node 20, which API 26.5.2 supports, and runs as the non-root `node` user with writable `/data` and `/actual-cache` mount points.

## Tasker request

An importable Tasker 6.6 project is provided at `tasker/Actual_SMS_To_Budget.prj.xml`. Copy it to the phone, open Tasker, long-press the project tabs at the bottom, choose **Import Project**, and select the XML file. During import, enter the service's public HTTPS base URL without a trailing slash and the `API_KEY` value from `.env`. Enable all three imported profiles and grant Tasker SMS and precise/background location permissions when Android prompts. Exclude Tasker from battery optimization so received-SMS events can run reliably with the screen off.

The project listens only to `AlRajhiBank`, `SAB`, and `STC Bank`. It requests a fresh location (30-second timeout), safely JSON-encodes the SMS and location, and submits it over HTTPS. If location is unavailable, the SMS is still submitted without a location rather than discarded. A toast is shown only when the endpoint does not return `202`.

Create a profile for received SMS and an HTTP Request task:

- Method: `POST`
- URL: `https://your-host/v1/sms`
- Headers: `Content-Type: application/json` and `X-API-Key: your-key`
- Body:

```json
{
  "eventId": "%SMSRF-%TIMES",
  "sender": "%SMSRF",
  "message": "%SMSRB",
  "receivedAt": "2026-08-22T13:10:30+03:00",
  "location": { "latitude": 24.7136, "longitude": 46.6753, "accuracyMeters": 25 }
}
```

Use Tasker's own ISO timestamp expression for `receivedAt` and JSON-safe variable handling. Location is optional. A `202` response means queued, not imported. Poll the returned `statusUrl` with the same API key. Duplicate `eventId` values return the original event.

Statuses are `queued`, `processing`, `imported`, `imported_review`, `ignored`, `needs_review`, and `failed`. OTP, login, declined, and insufficient-funds notifications are intentionally ignored. Unknown or malformed SAB/Al Rajhi templates and STC Bank messages are retained as `needs_review`; they do not create an Actual transaction or retry within the current parser revision. `GET /v1/events/:id` includes the original input, complete transition history, enrichment attempts, mapping provenance, the safe `parserReason`, and operational `error` values. `GET /v1/events` provides cursor-paginated summaries with optional `status`, `enrichmentStatus`, `from`, and `to` filters; raw SMS and location appear only in the authenticated detail response. Processing retries use 1 minute, 5 minute, 30 minute, and 2 hour delays; terminal errors stay queryable.

On startup, each parser revision requeues retained ignored and needs-review notifications from an earlier parser revision once. Events already imported are never replayed. This lets a corrected template import an older missed transaction while Actual's stable import ID prevents duplicates.

### Inbox polling (Tasker)

An alternative Tasker 6.6 project is provided at `tasker/Actual_SMS_Inbox.prj.xml`. Instead of reacting to received-SMS events, it reads the Android SMS database (`content://sms/inbox`) every 5 minutes and uploads everything new, so notifications missed while Tasker is killed, the screen is off, or the device was offline are recovered on the next poll. Import it the same way as the event project, entering the HTTPS base URL and `API_KEY`, enable the profile, and grant Tasker SMS permission. Disable the `Actual_SMS_To_Budget` project while this one is enabled. Deploy the matching server version before importing this project because it uses the `/v1/inbox-sync` API.

The durable `(date, _id)` checkpoint now belongs to the server, not Tasker. Each task execution fetches it from `POST /v1/inbox-sync/start`, reads all inbox rows after it without a sender filter, and sends batches of 25 oldest-first to `POST /v1/inbox-sync/batch`. The server classifies senders case-insensitively, queues supported bank notifications, retains STC Bank messages for review, discards unsupported or empty messages without storing their content, and advances through every acknowledged row in the same SQLite transaction. One task execution drains at most 10 batches (250 messages); a later poll resumes from the server checkpoint.

On first use, the server initializes the checkpoint seven days in the past. Existing events remain safe because the endpoint preserves `inbox-v2-<date>-<row _id>` IDs and deduplicates the migration replay. The old `%ActualSmsInboxV2*` Tasker globals are ignored and may be deleted. This protocol supports one active inbox-sync phone; disable the old phone before moving the project to another one.

- Every inbox SMS after the checkpoint transits the private HTTPS service. Unsupported content is classified in memory and is not written to the event database. Protect the endpoint and API key accordingly.
- `receivedAt` comes from the inbox `date` column. Location is unavailable during polling and is omitted.
- The client includes its expected checkpoint in each batch. A concurrent run or rewind produces `409 checkpoint_conflict`, so Tasker stops and fetches the authoritative checkpoint next time instead of skipping rows.
- Empty SMS bodies are acknowledged as `empty`, unsupported senders as `unsupported`, existing event IDs as `duplicate`, and new bank events as `queued`. Every valid row advances the checkpoint.
- Network errors and malformed responses require no local recovery state. If the server committed the batch, the next start call sees the advanced checkpoint; otherwise it returns the prior checkpoint.

The imported project also contains **Reconcile Inbox Last 7 Days**. Wait for an active sync to finish, run it to move the server checkpoint backward by seven days, and let the next poll replay that window safely. The rewind API refuses to move the checkpoint forward. The sync route has a 5 MiB body limit and accepts at most 25 rows per batch.

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
