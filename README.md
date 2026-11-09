# Tasker SMS → Actual Budget

Turn bank SMS notifications into transactions in Actual Budget.

Tasker checks your Android phone's inbox and sends new messages to this self-hosted service. The service saves supported bank messages to a queue, reads the transaction details, and imports them into your budget through Actual's official API. If your phone goes offline, Tasker picks up where it left off on the next sync.

The included configuration supports SAB, Al Rajhi, Wadaie, and D360. STC Bank messages are saved for review without creating transactions. You can add banks and adjust SMS recognition in YAML. You can also enable OpenCode Go to clean up merchant names and suggest categories.

## Get started

### 1. Have these ready

You'll need:

- An Android phone with Tasker 6.6 and SMS permission.
- A machine with Docker Compose, Node.js 20+, and npm.
- An Actual Budget server running **26.11.0**, matching the API version bundled with this service.
- A budget with the accounts and categories you want to use already created in Actual.
- An HTTPS address your phone can reach, with a reverse proxy forwarding requests to this service.

Have your Actual server URL, server password, and budget Sync ID ready. You can find the Sync ID in Actual under **Settings → Show advanced settings → Sync ID**. If your budget is encrypted, you'll also need its encryption password.

> [!WARNING]
> Keep the Actual server and this service's bundled API on matching versions. A mismatch or failed version discovery blocks startup before opening the production budget. Follow [Upgrading Actual](#upgrading-actual) when updating your server.

### 2. Run the setup wizard

From this repository's directory, run:

```sh
npm run setup
```

You don't need to run `npm install` on the host for Docker setup. This command builds the production image and runs the wizard in a temporary container, avoiding native SQLite dependency problems on the host.

The wizard connects to Actual, downloads your budget, and lets you choose from its open accounts and expense categories. Add only the banks and accounts you use. For each account, choose its bank and how to recognize it: the final digits shown in its SMS, the transaction type, or whether the message includes a balance. These identifiers come from your messages; they aren't Actual account IDs.

Setup writes `.env` and `config/accounts.yaml`, and generates an API key for Tasker. Both files are private and gitignored. Existing files are left alone unless you explicitly run `npm run setup -- --force`.

Use an Actual server URL that both the setup container and the running service can reach. Inside Docker, `localhost` means the container itself. If your Actual hostname needs an explicit IP mapping, see [Docker networking](#docker-networking).

The wizard gets its bank list from `config/banks.yaml`. If your bank isn't listed, [add it](#adding-a-bank) before running setup.

### 3. Start the service

```sh
docker compose -f compose.example.yaml up --build -d
```

Check that it's ready:

```sh
curl --fail http://localhost:3000/readyz
```

The default Compose file binds port 3000 to the host's loopback address. Set up your HTTPS reverse proxy to forward requests to it. For a proxy running in Docker, see the [optional proxy network configuration](#docker-networking).

The service checks your configured Actual account and category names at startup. They must match existing, open entries exactly. Missing or ambiguous names prevent the service from becoming ready; it never creates accounts or categories for you.

### 4. Connect Tasker

Copy [`tasker/Actual_SMS_Inbox.prj.xml`](tasker/Actual_SMS_Inbox.prj.xml) to your phone. In Tasker, long-press the project tabs at the bottom, choose **Import Project**, and select the file.

During import, enter:

- **Actual SMS service URL:** this service's HTTPS base URL, with no trailing slash. Use the SMS service URL here, rather than the Actual server URL.
- **Actual SMS API key:** the generated `API_KEY` from `.env`.

If Tasker doesn't prompt, open the imported project's properties and set those two values there. Enable the imported profile, grant SMS permission, and apply Tasker's changes. Disable battery optimization for Tasker and allow it to run in the background.

If you used the older immediate-forwarding project, disable or delete it before enabling this one. The current project requires a service version that supports `/v1/inbox-sync`.

### 5. Check your first sync

Run **Sync SMS Inbox To Actual Budget** manually once. The first sync reads the last seven days of messages; after that, Tasker checks every five minutes.

View received events using the `X-API-Key` header, then check the imported transactions in Actual:

```sh
curl --fail \
  -H 'X-API-Key: YOUR_API_KEY' \
  https://sms.example.test/v1/events
```

Replace the example URL and key with your own. An event marked `needs_review` needs a closer look at `GET /v1/events/:id`; see [Event status and review](#event-status-and-review).

If no events arrive, check Tasker's run log, SMS permission, project variables, and access to the HTTPS address. If events arrive but won't import, check the service logs and your Actual account/category names. Whenever you change the service URL or API key, update the project's values on your phone too.

## Optional web management

An opt-in management page provides importer status, read-only SMS audit, YAML-backed account editing, and Tasker project/checkpoint management. Existing headless deployments keep working unchanged. The browser does not introduce another configuration authority, parser, or financial dashboard; manual transaction approval is not enabled.

See [Browser management](docs/management.md) for secure provisioning, read-only and writable-directory deployment options, verification, and rollback. The [adoption plan](docs/web-management-adoption-plan.md) records the scope and the separate manual-review design gate.

## Configuration

The main configuration files are:

| File                   | What it controls                                                              |
| ---------------------- | ----------------------------------------------------------------------------- |
| `.env`                 | Server connection, API keys, file paths, and runtime settings                 |
| `config/accounts.yaml` | How SMS accounts map to your existing Actual accounts and categories          |
| `config/banks.yaml`    | Bank IDs, sender names, and whether messages are imported or saved for review |
| `config/parsing.yaml`  | Shared English/Arabic SMS recognition and optional message templates          |

Restart the service after changing configuration. Keep `.env` and `config/accounts.yaml` private; the tracked examples contain made-up values.

### Manual setup

If you'd rather edit the files yourself, copy `.env.example` to `.env` and `config/accounts.example.yaml` to `config/accounts.yaml`. Replace all example names and suffixes with your own, and remove unused account entries. Account and category names must exactly match existing, open entries in Actual.

Leave `OPENCODE_GO_API_KEY` empty to turn off AI suggestions. `ENRICHMENT_MIN_CONFIDENCE` defaults to `0.70`. `MAPPING_REFRESH_MINUTES` controls how often the service learns category changes you've made in Actual; the default is 60 minutes.

You can also run the wizard with `npm run setup:host` if you've successfully installed the host dependencies, including Actual's native SQLite module.

### Docker networking

If Actual's hostname needs a specific IP address inside Docker, copy `compose.host-override.example.yaml` to `compose.host-override.yaml`, set `ACTUAL_HOSTNAME` and `ACTUAL_HOST_IP`, and include the file when starting the service:

```sh
docker compose -f compose.example.yaml -f compose.host-override.yaml up --build -d
```

The setup container accepts the same kind of mapping:

```sh
ACTUAL_SMS_ACTUAL_HOST=actual.example.test:10.0.0.5 npm run setup
```

To attach the service to an existing reverse-proxy network, copy `compose.proxy.example.yaml` to `compose.proxy.yaml`, set `PROXY_NETWORK` if needed, and include it with `-f compose.proxy.yaml`. Both local override files are gitignored. You can include both if your deployment needs them.

### Account routing

A single bank sender can send messages for several accounts. Routing rules tell the service which Actual account each message belongs to.

Every rule names a `bank` and uses at least one of these matching options:

| Option                        | Use it when…                                                |
| ----------------------------- | ----------------------------------------------------------- |
| `accountSuffixes`             | The SMS identifies an account or card by its final digits   |
| `transactionKinds`            | The transaction type identifies the account                 |
| `hasBalance: true` or `false` | The presence or absence of a balance distinguishes accounts |

Rules must not overlap. For example, Al Rajhi credit-card messages with a numeric balance can route separately from checking messages without one.

For transfers, `transferIdentifiers` optionally lists destination aliases. `billPaymentIdentifiers` maps biller codes to destination accounts. These options don't affect ordinary account matching, and transfer destinations can belong to any configured bank. If a bank identifies accounts in `From` and `To` fields, give each account its suffixes without transaction-type shortcuts so the service can match the source or destination correctly.

Tasker always sends the full message, so account routing changes don't require changes on your phone.

D360 uses `bank: d360` and the card suffix shown in the SMS. Set `actualName` to the exact name of your existing Actual account. For an international purchase such as `JPY 878.00 (SAR 20.91)`, the service imports the SAR equivalent plus any separately reported fee and keeps the foreign amount in the notes. It never treats a yen amount as SAR. Run **Reconcile Inbox Last 7 Days** after enabling D360 to pick up messages that were previously skipped.

### Adding a bank

Add the bank to `config/banks.yaml`. This registry supplies the setup wizard's bank list and tells the service how to identify incoming senders. For example, add this entry under `banks`:

```yaml
- id: example-bank
  name: Example Bank
  senders: [ExampleBank, Example Bank]
  disposition: import
```

Then add a route under `accounts` in your local `config/accounts.yaml`. Use an existing Actual account name and the suffix shown in your SMS:

```yaml
accounts:
  - actualName: Example Checking
    match:
      bank: example-bank
      accountSuffixes: ['1234']
```

Sender aliases match the whole sender name, ignoring case and extra whitespace. They are literal names, so list each spelling your phone receives; regexes and partial matches aren't supported.

For older requests that omit the sender, optional `messageAliases` can identify the bank from the message text. These matches require word boundaries. If a message matches more than one bank, it's saved for review.

`disposition` defaults to `import`. Set it to `needs_review` to save a bank's messages without importing them. Review-only banks aren't offered in setup and can't have account routes.

Choose a stable bank ID beginning with a lowercase letter and containing only lowercase letters, digits, underscores, or hyphens. Routing and transaction deduplication depend on these IDs. Startup rejects duplicate IDs or aliases, unknown bank IDs in account routes, and routes for review-only banks.

If the bank's wording already fits the shared English/Arabic rules, YAML changes are all you need. For different wording or field labels, add a [custom SMS template](#custom-sms-templates). Messages from registered import banks that can't be understood are saved for review.

Restart after editing the files, then run **Reconcile Inbox Last 7 Days** to recover recent messages from the newly supported sender. Changing bank configuration alone does not retry events already saved for review.

Compose mounts the registry at `/config/banks.yaml`. Older deployments need to add that mount; existing account mappings don't need to change. To use another location, mount the file there and set `BANKS_CONFIG_PATH`. For host development, use `BANKS_CONFIG_PATH=config/banks.yaml`. Setup reads the repository's registry by default.

### Custom SMS templates

All banks share one parser engine and a set of English/Arabic rules in `config/parsing.yaml`. Bank identification is a separate step used for routing. The parser reads transaction details; routing and processing handle account matching and transfers between your own accounts.

You can add a template when a bank uses wording the shared rules don't recognize. Add it under `templates` in `config/parsing.yaml`, then reference its ID on the bank entry in `config/banks.yaml` with `templates: [example-purchase]`.

For example:

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

This recognizes a purchase containing `Statement debit` and extracts its amount from `Paid SAR …`. It uses the shared account extractor and requires both an amount and an account alias.

Templates work as follows:

- Patterns run after Arabic digits are converted, thousands separators are removed, and whitespace is collapsed.
- Use single-quoted YAML regex strings to preserve backslashes. Flags can include `i`, `m`, `s`, and `u`, each once. The engine handles repeated matching.
- Scalar field patterns must capture `value`. The `foreign` field captures `amount` and `currency`.
- Pattern lists run in order. Keep specific transaction kinds, such as card payments and transfers, before generic purchases in the shared rules.
- Fields you leave out use the shared extractors. If you override a field and its pattern doesn't match, that field stays absent.

Supported fields are `accountAlias`, `accountAliases`, `from`, `to`, `iban`, `beneficiary`, `biller`, `merchant`, `principal`, `total`, `fee`, `balance`, `foreign`, `date`, `sarEquivalent`, and the boolean marker `cashback`. Amount fields describe SAR amounts; foreign amounts are stored separately. Dates use the supported formats and Riyadh timezone, falling back to the time the SMS was received. YAML templates can't run custom conversion code or accounting formulas.

Ignored notifications and review-only banks are handled before template matching. With exactly one matching template, the service uses its transaction kind and field overrides. With none, it uses the shared rules. Missing or invalid required fields send the message to `needs_review`; multiple matching templates do the same with reason `ambiguous_template`. Purchase, refund, transfer, and fee accounting stays in the shared engine.

Test new templates against both messages they should match and messages they shouldn't. Restart after edits, and deploy bank and parser configuration together. Setup and startup validate the parser configuration and bank template references. Invalid versions, fields, flags, regexes, captures, or references are rejected.

Compose mounts this file at `/config/parsing.yaml`; older deployments need to add the mount. `PARSING_CONFIG_PATH` can select another mounted location. For host development, use `PARSING_CONFIG_PATH=config/parsing.yaml`.

The current parser revision is 15, which includes account-reference and transfer-identity fixes. A parser revision can trigger [reprocessing of older events](#event-status-and-review), but editing YAML alone doesn't trigger a historical replay. Imported events are never replayed.

## Event status and review

Use `GET /v1/events` to see what's been received and `GET /v1/events/:id` to inspect a particular message. Both require the `X-API-Key` header.

| Status            | Meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `queued`          | Saved and waiting to be processed                                |
| `processing`      | Currently being processed                                        |
| `imported`        | Imported into Actual                                             |
| `imported_review` | Imported, but needs your attention                               |
| `ignored`         | Recognized as a notification that shouldn't create a transaction |
| `needs_review`    | Saved for inspection without creating a transaction              |
| `failed`          | Processing failed; details remain available                      |

OTP, login, declined, and insufficient-funds notifications are intentionally ignored. Unrecognized or malformed messages from registered banks, along with messages from review-only banks, are saved as `needs_review`. They don't retry within the same parser revision.

The event list has cursor pagination and optional `status`, `enrichmentStatus`, `from`, and `to` filters. Event details include the original input, status history, enrichment attempts, the source of merchant/category mappings, `parserReason`, and operational `error` values. Raw SMS and location are available only in the authenticated detail response.

Processing retries wait 1 minute, 5 minutes, 30 minutes, and 2 hours. Events remain available to inspect after a terminal error.

When a new parser revision starts, it gives retained `ignored` and `needs_review` events from earlier revisions one more attempt. This allows a parser fix to recover a missed transaction. Already imported events are never replayed, and Actual's stable import IDs prevent duplicates.

## How inbox sync works

The Tasker project reads Android's SMS inbox (`content://sms/inbox`) every five minutes. It resumes from a checkpoint stored on the server, so it can catch up after Tasker stops or the phone loses connectivity. On first use, the checkpoint starts seven days in the past.

The service supports one active inbox-sync phone. Disable the old phone's project before moving to another one. The old `%ActualSmsInboxV2*` Tasker globals are no longer used and can be deleted.

Every SMS after the checkpoint passes through your private HTTPS service. The service checks the sender against `config/banks.yaml`, queues supported bank messages, and saves review-only bank messages for inspection. Unknown senders and empty messages are skipped without storing their content. Polling uses the inbox `date` as `receivedAt` and doesn't include location.

### Recheck the last seven days

Run **Reconcile Inbox Last 7 Days** when you've enabled a bank or want to resend recent inbox messages. Wait for any active sync to finish first.

The task moves the server checkpoint to seven days ago, and the next poll works through that window again. Existing event IDs prevent duplicate imports. If the checkpoint is already farther back, reconciliation leaves it there. Resending an event already saved for review doesn't automatically reprocess it after a configuration change.

### Protocol details

Each Tasker run calls `POST /v1/inbox-sync/start` to get the checkpoint, reads all later inbox rows without filtering senders, and sends the oldest first to `POST /v1/inbox-sync/batch`. Batches contain up to 25 rows; one run sends at most 10 batches, or 250 messages. The next poll continues from there.

The checkpoint tracks the inbox row's `(date, _id)`. Tasker sends these identifier fields as received from Android. The server normalizes and validates them, then saves events and advances the checkpoint in the same SQLite transaction. Event IDs use `inbox-v2-<date>-<row _id>`, which also prevents duplicates when replaying messages during migration.

Each batch includes the checkpoint Tasker expects. If another run or a rewind has changed it, the server returns `409 checkpoint_conflict`. Tasker stops and gets the current checkpoint next time. Network failures don't need local recovery: if the server committed the batch, the next start call returns the advanced checkpoint; otherwise, it returns the previous one.

Valid rows are acknowledged as `empty`, `unsupported`, `duplicate`, or `queued`. Each advances the checkpoint. The sync route has a 5 MiB body limit and accepts at most 25 rows per batch.

The Tasker SQL query uses `|~sms~|` as its column divider. The server also accepts unsplit comma-separated rows from older imports that lost their tab divider, preserving commas and newlines within message bodies.

## Merchant names, categories, and privacy

Before asking AI for help, the service looks for an exact match on the normalized merchant name and Actual account. It learns these mappings from categorized Actual transactions, your manual corrections, and successful SMS enrichments. Actual history refreshes at startup and every hour by default. A match reuses the previous payee and category without an AI request; any active expense category can be reused.

If there's no match and you've configured `OPENCODE_GO_API_KEY`, the service asks OpenCode Go for a merchant name and category suggestion. It sends only normalized merchant text, optional exact location/time context, and the configured eligible category IDs and names. It doesn't send raw SMS, balances, account suffixes, aliases, or unrelated personal data.

The default model is `deepseek-v4-flash`; change it with `OPENCODE_GO_MODEL`. Requests use OpenCode's OpenAI-compatible Chat Completions endpoint in JSON-only mode, and responses are validated locally. This step uses the model without web search.

A category is applied only when confidence meets `ENRICHMENT_MIN_CONFIDENCE`, which defaults to `0.70`. A lower-confidence suggestion may still clean up the payee name. Provider failures, invalid output, quota limits, rate limits, and timeouts don't prevent an otherwise valid transaction from importing. Sanitized requests, responses, timings, outcomes, and failure details are saved in the event audit.

### What stays on your server

The SQLite database keeps raw SMS, any supplied location, status changes, mapping decisions, enrichment attempts, and import outcomes indefinitely for authenticated review. Queue data and Actual's local cache live in separate persistent Docker volumes. This service doesn't encrypt those volumes, so protect access to the host and Docker.

### What gets imported

Actual's rules remain authoritative. Transactions are imported as cleared, use a stable `imported_id` to prevent duplicates, and sync after writes. Actual's default behavior of not reimporting deleted entries is preserved.

For foreign-currency messages without a SAR amount, the service uses chronological balance changes when it can do so safely. Otherwise, it imports a zero-value transaction marked `REVIEW REQUIRED`.

## Development

Install dependencies, then run the full check:

```sh
npm install
npm run check
```

Normal tests don't contact Actual or OpenCode and need no services or environment variables. `npm run check` runs formatting, lint, type checking, and tests in that order. Run it before considering a change complete; GitHub CI also runs this gate and the build.

Useful commands:

| Command                              | Purpose                                             |
| ------------------------------------ | --------------------------------------------------- |
| `npm run dev`                        | Run with automatic reload through tsx               |
| `npm run build`                      | Compile to `dist/src/main.js`                       |
| `npm start`                          | Run the compiled service                            |
| `npm test`                           | Run the regular tests                               |
| `npx vitest run test/parser.test.ts` | Run one test file; add `-t 'name'` to select a test |
| `npm run typecheck`                  | Check TypeScript types                              |
| `npm run format`                     | Apply Prettier formatting                           |
| `npm run lint:fix`                   | Apply safe ESLint fixes                             |

The service uses Fastify and runs on Node 22 in the production image. The container runs as the non-root `node` user, with writable `/data` and `/actual-cache` mounts.

### Disposable Actual smoke test

The live smoke test creates and deletes a transaction. Use a separate, disposable budget with a uniquely named test account. It refuses to run without `LIVE_ACTUAL_TEST=1` and explicit credentials.

The test creates a uniquely identified zero-value transaction, checks it after syncing, deletes it, and syncs again. If cleanup fails, it exits with an error and prints the identifier so you can remove the transaction yourself.

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

`ACTUAL_SMOKE_ENCRYPTION_PASSWORD` is optional; all other variables shown are required. These credentials apply only to the smoke test and don't change production startup settings.

To include the OpenCode Go smoke test in the test run, set `LIVE_OPENCODE_GO_TEST=1` and an explicit `OPENCODE_GO_API_KEY`.

### Upgrading Actual

The `@actual-app/api` dependency is pinned to **26.11.0** to match the deployed Actual server. Startup reads the installed API version and checks server metadata before opening the budget. Mismatches and discovery failures block imports. Authentication, download, and migration failures also prevent startup.

When upgrading manually:

1. Upgrade the Actual server.
2. Set `@actual-app/api` to that exact version, without `^` or `~`, and regenerate `package-lock.json`.
3. Run `npm run check` and `npm run build`.
4. Rebuild the Docker image and run the disposable smoke test before deployment.

If you see `out-of-sync-migrations`, update the API client to a version that includes your server's migrations. Keep the Node runtime compatible with the pinned API; API 26.11.0 requires Node 22 or newer.

## License

MIT. See [LICENSE](LICENSE).

### Automatically managed disposable smoke budget

`npm run smoke:disposable` creates a new empty budget on the configured Actual
server, creates synthetic accounts and categories, runs the original smoke test
from a separate client cache, and exercises the SMS processor against the real API.
It verifies merchant classification, Riyadh dates, equal-purchase identities,
linked transfers, fees, and retry idempotency before deleting the disposable budget.
It never downloads or opens an existing budget. Remote cleanup is independently
verified because Actual's low-level deletion handler can suppress server errors.

Explicitly set `LIVE_ACTUAL_TEST=1`, `ACTUAL_SMOKE_CREATE_BUDGET=1`,
`ACTUAL_SERVER_URL`, and `ACTUAL_SMOKE_PASSWORD`. No production budget Sync ID is
required. Normal service startup still never creates accounts or categories.
Use a Node 22 environment with working native dependencies, or run the compiled
smoke runner shipped in the production image:
`node /app/validation/scripts/smoke-disposable.js`. For that container command, mount
the nonpersonal bank/parsing YAML files read-only and set their container paths via
`BANKS_CONFIG_PATH` and `PARSING_CONFIG_PATH`. Use a private env file for credentials.
Do not mount production queue or cache volumes into the smoke container.

Optional `ACTUAL_SMOKE_REPORT_PATH` writes an owner-only lifecycle report. A
passing result is written only after both validation and cleanup succeed. On cleanup failure, the command exits nonzero and
reports the unique temporary budget name and retained cache for recovery.
