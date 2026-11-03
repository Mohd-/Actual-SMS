# AGENTS.md

## Commands

- `npm run check` — full gate in strict order: `format:check` → `lint` → `typecheck` → `test`. Run this before considering work done. The GitHub workflow also runs this gate and the build on Node 20.
- Single test file: `npx vitest run test/parser.test.ts`. Single test: add `-t 'name'`.
- `npm run lint` uses `--max-warnings 0` — zero-tolerance.
- `npm run build` outputs `dist/src/main.js` (what `npm start` runs); `npm run dev` uses tsx watch.

## Language/toolchain constraints

- ESM + NodeNext: relative imports in TS source **must** end in `.js` (e.g. `./types.js`).
- TypeScript `strict` + `noUncheckedIndexedAccess`.
- ESLint: `@typescript-eslint/no-explicit-any` is intentionally off for SDK boundary casts; unused args/vars must be prefixed `_`.
- Prettier formats everything; run `npm run format` / `npm run lint:fix` rather than hand-fixing style.

## Architecture

Single Fastify service that queues Tasker SMS events, parses them, and imports transactions into Actual Budget. Flow: `server.ts` (HTTP `/v1/sms`, `/v1/events`) → `db.ts` (better-sqlite3 durable queue + audit) → `processor.ts` (retries, enrichment) → `parser.ts` → `routing.ts` → `actual.ts` (Actual import) with `enricher.ts` (OpenCode Go LLM, optional) and `merchant-resolver.ts` (history-first mapping, no LLM on hit).

- `config/parsing.yaml` holds shared English/Arabic recognition and extraction rules plus optional bank-selected message templates; the TypeScript parser engine is shared. Bank identification lives separately in `sms-source.ts` and only feeds routing. Runtime loads parser configuration via `PARSING_CONFIG_PATH`. Regex rule order in the shared grammar is semantic: specific kinds (card payment, transfer) must precede generic ones (purchase).
- Bank IDs, exact sender aliases, legacy message aliases, and import/review disposition live in `config/banks.yaml`. Runtime loads it via `BANKS_CONFIG_PATH`; setup reads the repository registry. New banks with recognized wording require YAML changes only.
- The service never creates Actual accounts or categories; configured names in `config/accounts.yaml` must exactly match existing open names, and startup fails if a name is missing or ambiguous.
- `@actual-app/api` is pinned to an **exact** version (26.5.2, no `^`/`~`) matching the deployed Actual server. Upgrading requires: upgrade Actual server → bump pin → regenerate lockfile → `npm run check` && `npm run build` → rebuild image → smoke test. See README "Upgrading Actual".

## Testing quirks

- Normal tests never contact Actual or OpenCode; no services or env vars are required.
- Live smoke tests are opt-in and destructive: `npm run smoke:actual` refuses to run without `LIVE_ACTUAL_TEST=1` plus explicit credentials (README has the full command). `LIVE_OPENCODE_GO_TEST=1` + `OPENCODE_GO_API_KEY` gates the LLM smoke test.

## Environment & deployment

- Secrets/config are local-only and gitignored: `.env` (from `.env.example`), `.gitenv`, and `config/accounts.yaml` (from `config/accounts.example.yaml`).
- `better-sqlite3` needs native builds; `npm run setup` (scripts/setup-docker.sh) runs the setup CLI inside Docker to avoid host-native SQLite issues. `setup:host` only works if host deps built successfully.
- Deployment is Docker Compose (`compose.example.yaml`). Optional examples add a reverse-proxy network or an explicit Actual hostname/IP mapping; the base Compose file has neither assumption.
- Preserve `event_import_ids` with the queue: it retains pre-upgrade import IDs and distinguishes later equal transactions. Never run two ingestion projects or two processors against the same budget during cutover. See `MIGRATION.md` for deployment and rollback requirements.
