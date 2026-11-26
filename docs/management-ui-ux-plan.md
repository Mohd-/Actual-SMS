# Management console UI/UX transformation plan

Status: implemented through the structured routing, bank, recognition, payee, audit, and Tasker
screens. Recognition editing remains gated behind `MANAGEMENT_EDIT_PARSING` with a read-only
fallback. This document remains the design and acceptance record; it does not change runtime
behavior by itself.

Audience: maintainers implementing and reviewing the management-console redesign.

Related documents:

- [Browser management](management.md)
- [Narrow web management adoption plan](web-management-adoption-plan.md)
- [`AGENTS.md`](../AGENTS.md)

## 1. Objective

Turn `/manage` from a functional but text-centric operator page into a calm, fast, accessible
console that represents each problem domain with the interface that fits it:

- Status as a health dashboard, not a JSON dump.
- SMS audit as a filterable, master-detail table.
- Payees as an interactive data table with inline defaults, descriptor links, conflicts, and
  suggestions.
- Account routing as a structured rule builder instead of a YAML textarea.
- Banks as an editable registry with alias chips and safe ID handling.
- Recognition rules as a grammar workbench with a live SMS tester, not a wall of YAML.
- Tasker setup as a guided phone-connection flow.

The persisted format remains YAML and the files remain the single configuration authority. The
change is that operators no longer read or write YAML by hand in the browser.

### Non-goals

- No financial dashboard, balance charts, or transaction browsing beyond the existing SMS audit.
- No manual transaction approval, transaction editing, or replay workflow. Phase 6 of the adoption
  plan remains gated.
- No second parser, routing engine, or configuration store.
- No browser storage of credentials or configuration.
- No changes to bank recognition, import IDs, fee policy, or transfer matching unless a separate
  change is explicitly reviewed.
- No external CDN, analytics, telemetry, web fonts from third parties, or inline scripts/styles.
- No new settings for Actual credentials, filesystem paths, or arbitrary environment variables.

### Required invariants

1. Files remain authoritative. The UI edits the existing YAML files through the existing
   `ConfigEditor` save/activation protocol.
2. Headless deployments remain unchanged. Management stays optional and disabling it leaves
   ingestion/processing running with the same configuration.
3. Raw SMS remains available only in authenticated detail views, never in summary responses, URLs,
   logs, or browser storage.
4. Existing security properties remain: exact-origin writes, secure sessions, revocation, login
   throttling, no-store responses, CSP, and safe text rendering.
5. Revision conflict, save locking, preview invalidation, checkpoint tuple conflicts, and one-time
   Tasker key reveal remain enforced.

## 2. Current state

The management layer is secure and functionally complete, but the browser application is still a
single 593-line DOM script with a 63-line stylesheet.

| Area            | Current implementation                                                       | UX problem                                                                                       |
| --------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Shell           | Static hidden sections in `web/index.html`, buttons in `browser.ts`          | No routing, deep links, global loading/error patterns, dialogs, or responsive navigation.        |
| Status          | JSON in `<pre>` plus two buttons                                             | No hierarchy, health explanation, queue visualization, or last-updated state.                    |
| SMS audit       | Button list, JSON detail, status filter only                                 | API supports date/enrichment filters and cursors; UI exposes almost none. Poor on small screens. |
| Payees          | `<ul>` of buttons plus a long form                                           | No table, inline editing, alias overview, bulk actions, or clear conflict resolution.            |
| Configuration   | Raw YAML `<textarea>`; banks and parsing are read-only `<pre>` blocks        | Requires YAML literacy, offers no domain validation UX, and is easy to edit incorrectly.         |
| Tasker          | Mixed form, `window.confirm`, sensitive key in a plain password input        | No guided flow, one-time key ceremony, checkpoint impact explanation, or mobile-first layout.    |
| Global design   | System font stack, browser-default controls, no tokens or component system   | Inconsistent density, weak focus states, poor mobile ergonomics, no Arabic typography strategy.  |
| Browser code    | Direct element IDs, global mutable state, no view-model seam                 | Hard to test without a browser and hard to extend safely.                                        |
| Arabic handling | Data rendered as-is; no explicit direction, font, or bidi isolation strategy | Mixed Arabic/English SMS, payee names, and amounts can reorder or wrap poorly.                   |

What must survive the redesign:

- `test/management.test.ts` authorization, origin, throttling, privacy, payee, configuration,
  checkpoint, and Tasker assertions.
- `src/management/routes.ts` save/activation semantics and `src/config-editor.ts` atomic writes.
- The current browser smoke coverage for stale previews, confirmation invalidation, external
  revision conflicts, save locking, read-only mode, escaping, time zones, and mobile overflow.
- The adoption-plan invariants and phase-6 gate.

## 3. Design direction

### Principles

- **Quiet by default.** Neutral surfaces, one accent, thin borders, no decorative gradients or
  oversized hero areas. The data is the interface.
- **Dense where it helps, spacious where it matters.** Tables are compact for scanning; dialogs and
  destructive actions are deliberate and roomy.
- **Progressive disclosure.** Show the common path first; move advanced routing predicates, raw
  payloads, and YAML source into clearly labeled disclosures.
- **Explicit consequences.** Never rely on `window.confirm`; use accessible dialogs that state what
  changes, what is irreversible, and what happens to existing imports.
- **No lost work.** Drafts survive validation errors and conflicts. Destructive navigation warns.
- **Keyboard and touch are first-class.** No hover-only actions, 44px minimum targets, visible focus,
  and logical focus management.
- **One language for the interface, correct direction for the data.** The UI stays English and LTR;
  user-supplied Arabic text gets proper direction, typography, and bidi isolation.

### Visual references

Use these as interaction and quality references, not as dependencies:

- [shadcn/ui](https://ui.shadcn.com) for restrained component composition and density.
- [Radix accessibility guidance](https://www.radix-ui.com/primitives/docs/overview/accessibility)
  and the [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/) for combobox, dialog,
  menu, table, and disclosure behavior.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) for the accessibility acceptance criteria.
- Linear and Stripe Dashboard for calm information density; GitHub Primer for form/table clarity.
- Actual Budget's own language and visual plainness for domain familiarity.
- IBM Plex Sans paired with IBM Plex Sans Arabic (OFL) if a self-hosted font is added. System fonts
  remain an acceptable fallback; no Google Fonts or CDN.

### Visual system

Implement as one `web/style.css` organized with CSS layers (tokens, reset, layout, components,
screens), or split into an allowlisted `web/styles/` set if it grows beyond comfortable editing.

- **Type:** system UI / IBM Plex Sans; Arabic fallback IBM Plex Sans Arabic, Noto Sans Arabic,
  Tahoma, sans-serif. Body 14–16px, data tables 13–14px, headings 20/24/30px. Arabic line-height
  1.7–1.8 and zero letter-spacing; never uppercase user data.
- **Spacing:** 4/8/12/16/24/32/48 scale. 44px minimum interactive height.
- **Color:** warm neutral canvas, white/raised surface, ink text, one cool-green accent for primary
  actions and readiness; amber for review/warning; red only for failures/destructive actions. All
  status meaning must also be conveyed by text/icon, never color alone.
- **Surfaces:** 1px borders, 8–12px radius, subtle shadow only for overlays. No glassmorphism.
- **Icons:** 16/20px inline SVG stroke icons, defined locally (no icon font).
- **Motion:** 120–160ms ease for drawers/dialogs; respect `prefers-reduced-motion`.
- **Theme:** system light/dark via `prefers-color-scheme`; optional persisted theme toggle stored only
  as a non-sensitive preference.
- **States:** skeleton loading for first paint; inline pending state for actions; empty states with
  one clear next action; errors adjacent to the field or action that caused them.

### Shell and responsive behavior

- **Desktop ≥1024px:** persistent 232px sidebar with labeled navigation, content max-width ~1200px,
  side drawers 420–520px wide for details.
- **Tablet 641–1023px:** top bar with current section and menu button; content full-width; drawers
  can overlay.
- **Mobile ≤640px:** top app bar, slide-in navigation sheet, full-screen detail sheets, single-column
  forms, sticky action bars above the safe-area inset. Tables become stacked cards, never horizontal
  scrolling.
- Use CSS logical properties (`margin-inline`, `padding-inline`, `text-align: start`) and
  `min-width: 0` grids to prevent overflow.

### Screen map

| Route               | Screen      | Primary representation                                      |
| ------------------- | ----------- | ----------------------------------------------------------- |
| `#/status`          | Overview    | Readiness hero, pipeline counts, connection actions         |
| `#/events`          | SMS audit   | Filterable table/card list plus authenticated detail drawer |
| `#/payees`          | Payees      | Interactive table/card list plus inspector                  |
| `#/config/accounts` | Routing     | Grouped account cards with routing-rule rows                |
| `#/config/banks`    | Banks       | Registry cards with alias chips and usage                   |
| `#/config/parsing`  | Recognition | Grammar groups plus live SMS lab                            |
| `#/tasker`          | Phone setup | Guided key/origin/download/checkpoint flow                  |

### Component inventory

Build a small internal component layer in TypeScript; do not add a runtime UI framework.

- Buttons (primary, secondary, quiet, destructive), icon buttons with accessible labels.
- Status badge/chip with icon + text.
- Text inputs, search input, textarea, select/combobox (searchable, grouped, keyboard complete),
  tag/alias chip input, switch/segmented control.
- Data table with sticky header, sortable where meaningful, row selection only where an action
  exists, and a card fallback for mobile.
- Bullet/card list for banks and parsing rules.
- Drawer/sheet and dialog (`<dialog>` with focus trap/return), confirmation dialog, one-time secret
  reveal dialog.
- Toast region (`aria-live="polite"`) for background success/failure; inline alert for page-level
  errors.
- Skeleton, empty state, inline error, pagination footer, copy button with feedback.
- Tabs/segmented filters; disclosure (`<details>`) for advanced/raw data.
- `UserText` component for mixed-direction content.

## 4. Arabic and bidirectional text

The interface language remains English; only user data may be Arabic.

- Set `lang="en" dir="ltr"` on the document. Apply `lang`/`dir` locally to user text.
- `UserText` detects the dominant direction per line (Arabic/Hebrew script ranges, ignoring digits
  and punctuation) and wraps each line in an element with the correct `dir`, `lang`, and
  `unicode-bidi: isolate` or `<bdi>` where embedded. This avoids a numeric prefix forcing an Arabic
  SMS into LTR order.
- Use `white-space: pre-wrap`, `overflow-wrap: anywhere`, and `tab-size` for raw SMS. Preserve line
  breaks exactly; never render raw SMS through `innerHTML`.
- Surround amounts, account suffixes, event IDs, and currencies with `<bdi>` when they appear inside
  Arabic sentences. Keep IDs and command-like values `dir="ltr"`.
- Show Western digits in formatted amounts (matching Actual and bank messages) while preserving the
  original text in the raw SMS view. Use `Intl.NumberFormat` for amounts and `Intl.DateTimeFormat`
  for dates; include the local time zone label and expose ISO/UTC in a copy affordance.
- Search sends the operator's text unchanged. `merchantKey` already normalizes Arabic-Indic digits,
  NFKC, case, and punctuation on the server; the UI must not apply its own transliteration.
- Use `.text-user` for user content; avoid truncating Arabic names mid-word. If clamping, offer the
  full value via title/accessible description or the detail view.
- If a self-hosted Arabic font is added, subset it, use `font-display: swap`, serve from `/manage/`,
  and add `font-src 'self'` explicitly to the CSP for clarity.
- Test with: Arabic-only payee names, mixed `شراء SAR 12.00`, Arabic-Indic digits, long RTL SMS,
  French/accented names, and long unbroken event IDs.

## 5. Frontend architecture

### Rendering and state

Keep the current zero-runtime-dependency approach:

- TypeScript ES modules compiled by `tsc`; no React/Svelte/Vue.
- Small typed DOM helper (`el(tag, props, children)`) using `textContent` and explicit listeners.
- Route-level screen controllers with an `AbortController` and generation counter to ignore stale
  responses, following the existing race-safe pattern in `browser.ts`.
- Targeted DOM updates for inline table editing; full list re-render on fetch with focus restored by
  row ID. Append for cursor pagination so scroll position is preserved.
- Hash router (`#/status`, `#/events?status=failed`, `#/payees`, `#/config/accounts`,
  `#/config/banks`, `#/config/parsing`, `#/tasker`) so deep links and browser back/forward work
  without a server catch-all. Never put raw SMS, payee names, or secrets in the URL.
- One global session probe, toast queue, confirmation service, and theme preference. No
  configuration or credentials in `localStorage`/`sessionStorage`.

### Suggested module layout

```text
src/management/
  browser.ts                  # thin entry, re-exports web/main
  contracts.ts                # shared response/model types (extended)
  routes.ts                   # existing routes plus additive structured-config routes
  web/
    main.ts                   # bootstrap, session, router, error boundary
    api.ts                    # typed fetch client, abort, error mapping
    router.ts
    dom.ts                    # el, focus helpers, safe text rendering
    format.ts                 # Intl date/number/currency, relative time, direction
    models/                   # pure functions: status view, event filters, payee view,
                              # config patch builders, validation issue presentation
    components/               # buttons, inputs, combobox, table, drawer, dialog, toast,
                              # badge, skeleton, pagination, chip editor, UserText
    screens/                  # status.ts, events.ts, payees.ts, accounts.ts, banks.ts,
                              # parsing.ts, tasker.ts, login.ts
```

Pure model/format modules must not touch `document`, so Vitest can test them in Node.

Static serving: keep `/manage` and `/manage/style.css`; add an allowlisted same-origin route for the
compiled `dist/src/management/web/*.js` modules (or a tiny bundling step if module count becomes
painful). Reject path traversal and unknown extensions, keep `no-store`, and retain the existing CSP.
No inline style attributes are introduced.

### API client and errors

- Wrap existing endpoints in typed functions. Keep request bodies and response shapes close to
  `contracts.ts`.
- Normalize errors to `ApiError { status, message, code?, issues? }`. Map `401` to the login screen,
  `403` to an origin/session message, `409` to an inline conflict with reload/reapply guidance, `503`
  to reconnect/edit-unavailable guidance, `429` to a retry-later message.
- Disable duplicate submissions; show pending state on the initiating control. Never replace a draft
  with server data after a failed save.
- Keep existing server-side confirmations (`SAVE`, `ROTATE`, `CHANGE`) and have the new dialogs send
  them only after the operator confirms.

### Additive server API changes

The existing endpoints stay. The current text-oriented editor cannot support a YAML-free UI without
losing comments and unknown fields. Add a typed layer over the same `ConfigEditor` and validation
paths rather than replacing the API or creating a second configuration authority.

| Addition                                           | Purpose                                                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /management/config/model`                     | Normalized accounts/banks/parsing model, revision, active revision, per-file editability, diagnostics, and actual name/category catalog. |
| `POST /management/config/model/preview`            | Apply an allowlisted patch to the YAML document, validate the full configuration, and return issues and a human-readable change summary. |
| `POST /management/config/model/save`               | Same patch, explicit confirmation, existing revision check, atomic write, backup, and activation protocol.                               |
| `POST /management/config/refresh-catalog`          | Explicitly sync/read Actual account and category names for pickers; not a configuration save.                                            |
| `POST /management/config/test-message`             | Run the existing parser against a sample SMS with a candidate grammar/bank configuration; never enqueue or import.                       |
| `GET /management/payees?filter=...&includeTotal=1` | Optional additive filtering/count support for attention views. Keep search/pagination behavior unchanged.                                |
| Allowlisted compiled web modules                   | Serve the new browser modules without changing CSP or adding a CDN/bundler requirement.                                                  |

Structured validation should return issue objects with safe paths and messages (for example
`accounts[1].match.accountSuffixes`), while existing `ConfigurationError` behavior remains for the
text endpoints. Reuse `parseConfigFiles`, `ConfigEditor.preview/save`, and the runtime gate; do not
duplicate validation.

### YAML preservation model

The structured UI sends allowlisted patch operations against a revision, not a normalized object
tree. The server applies the patch to a `yaml` `Document`:

```ts
type ConfigPatch = {
  file: 'accounts' | 'banks' | 'parsing';
  op: 'set' | 'insert' | 'delete' | 'move';
  path: (string | number)[];
  value?: unknown;
  from?: number;
  to?: number;
};
```

- Allowlist paths per file: account rules and their match fields, global account options, bank
  fields, parsing rule groups and template arrays, and array order moves.
- Preserve comments, anchors, ordering, and unrelated top-level fields where possible. Untouched
  nodes are not serialized through a normalized object.
- New nodes are generated cleanly; edited scalar nodes keep their surrounding comments where the
  YAML library supports it.
- Reject unknown paths/operations and any candidate that cannot be preserved safely.
- If a file cannot be parsed into a `Document`, show a read-only diagnostic with recovery guidance
  (including the `.previous` copy). Never normalize or rewrite an unparseable file from the UI.
- Reuse the exact save protocol: revision check, full validation, atomic temp-file replace,
  `.previous` recovery copy, directory sync, activation, and stale/uncertain failure handling.
- For banks/parsing edits, add per-file edit gates (for example `MANAGEMENT_EDIT_BANKS` and
  `MANAGEMENT_EDIT_PARSING`, both requiring management). Default remains read-only until each phase
  passes its regression gate.

## 6. Domain blueprints

### 6.1 Authentication, shell, and navigation

- Minimal centered sign-in card with product name, password field, pending state, and clear
  error/rate-limit messaging. Do not reveal whether the password or origin was wrong.
- After sign-in, restore the requested hash route or default to Overview.
- Desktop sidebar: Overview, SMS audit, Payees, Routing, Banks, Recognition, Phone setup.
- Mobile: top bar with section name and menu sheet; current section marked; sign-out in the menu.
- Session expiry banner with “Continue” focus management before redirect; sign out and revoke-all
  remain distinct actions.
- Skip link, landmark regions, page titles, focus return after dialogs/drawers, toast region.
- Replace every `window.confirm` with a consequence-specific dialog.
- Guard dirty structured-config drafts on in-app navigation and `beforeunload`.

### 6.2 Overview (status)

- Read `GET /management/status`; show readiness, connection state, active revision, error, payee
  migration pending, and queue counts.
- Header status: Ready / Paused / Reconnecting / Disconnected with one-sentence explanation.
- Primary recovery alert only when not ready: reconnect, or point to configuration if the active
  revision is stale.
- Queue summary: accessible stacked/segmented bar plus a list of status counts and total; map unknown
  statuses safely. `needs_review` and `failed` are visually distinct and linked to filtered audit.
- Connection card: connected/changing state, short revision with copy, sanitized error, reconnect
  action, and a reminder that credentials are deployment-owned.
- Background refresh every 10–15 seconds only while the tab is visible; pause when hidden. Show
  “Updated just now” instead of flashing spinners. First load uses skeletons.
- Tests: ready, paused, disconnected, changing, migration pending, empty counts, reconnect
  double-click prevention, 401 expiry, hidden-tab polling, and sanitized error display.

### 6.3 SMS audit

- Filter bar: status segmented filter, date range, enrichment status (advanced), clear-all. Mobile
  opens filters in a sheet. API already supports `status`, `enrichmentStatus`, `from`, `to`, and
  cursor pagination.
- Desktop table columns: status, received (relative + local time), event ID (short mono + copy),
  parser reason, attempts, enrichment. Do not include SMS body. Mobile cards show the same facts.
- Row click opens a detail drawer/sheet:
  - Summary: status, event ID, created/updated, attempts, parser reason, Actual transaction ID.
  - Original SMS: `UserText` with preserved whitespace, direction, and copy.
  - Parsed result: kind, amount (formatted), payee, date, account alias, balance, foreign amount,
    notes, transfer identifiers. Unknown/absent fields are omitted rather than printed as `null`.
  - Suggestion/enrichment attempts and reasons.
  - Timeline from `history` with status transitions and timestamps.
  - Raw input/parsed JSON in a disclosure, rendered as text with copy, never `innerHTML`.
- Cursor pagination: “Load older” appends; keep a cursor stack so “Newer” works without refetching;
  preserve scroll. Empty state distinguishes “no events yet” from “no matches”.
- Keep event IDs in hash deep links; do not put bodies or raw payloads there.
- Tests: escaping `<script>`, Arabic/English mixed message rendering, long unbroken text, filter and
  pagination combinations, stale response cancellation, drawer focus/escape, and no raw SMS in list
  responses or URLs.

### 6.4 Payees

- Server data: existing `GET /management/payees`, save/link/unlink/suggestion endpoints. `PayeeView`
  already carries actual/local/unavailable state, category, tags, conflicts, revision, and aliases.
- Desktop table: Payee, Category, Tags, Descriptors, State. Search is server-side and debounced.
  Mobile renders cards with the same information.
- Inline editing:
  - Category cell opens a searchable, grouped combobox (“No category”, categories, group names when
    ambiguous).
  - Tags cell opens a checkbox/search popover; commit once when the popover closes.
  - Mutations are optimistic, revision-checked, and rolled back with an inline error on conflict.
    A pending row remains readable and does not lose the operator's draft; focus returns to the
    edited cell and completion is announced.
  - Optional bulk selection (set category, add/remove tag) follows once inline saves are stable and
    applies sequentially with a per-row conflict report. Do not ship it without partial-failure
    tests.
- Inspector drawer for:
  - Defaults: category, tags, migration conflict resolution, and the AI suggestion action.
  - Descriptors: each alias/descriptor with linked state, “Link” and “Use as separate payee.”
  - Link flow: search target payee, show target defaults and the exact effect, then confirm.
  - Unlink flow: state that a new blank payee will be created and which future imports are affected.
- Migration conflicts: show the previous choices grouped by account/descriptor with a category
  choice and a clear “Leave uncategorized” resolution. Do not hide conflicts in a text paragraph.
- Suggestion: make it explicit (“Suggest category”) and attributed to the configured OpenCode Go
  integration. Applying a suggestion sets the draft only; it never saves or imports.
- Pagination: keep 50-row pages, show range, Previous/Next or Load more. If attention filters are
  required globally, use the additive `filter`/`includeTotal` query; do not pretend a client-side
  filter covers unseen rows.
- Empty state: explain whether the catalog is unavailable/disconnected or the search has no match.
- Tests: Arabic/French search and aliases, inline save, conflict rollback, tag edits, link/unlink,
  conflict resolution, unavailable payee, read-only/disconnected mode, pagination, mobile cards, and
  keyboard-complete combobox behavior.

### 6.5 Account routing

- Replace the YAML textarea with grouped account cards:
  - Actual account name combobox (catalog of existing Actual accounts; exact-name validation).
  - One or more routing rules per account, preserving multiple non-overlapping rules.
  - Rule fields: bank, account suffixes, transaction kinds, `hasBalance` tri-state, transfer
    identifiers, bill-payment identifiers. Only show advanced identifiers on demand.
  - Chip inputs accept comma/space-separated paste and Backspace-to-remove; `inputmode="numeric"`
    for suffixes/identifiers.
- Global settings: bank-fees category (single-select of active expense categories) and enrichment
  categories (“All eligible” by default, or selected categories).
- Pickers select existing Actual accounts/categories only. The UI never offers to create Actual
  objects; missing or ambiguous names remain hard validation failures.
- Inline diagnostics for unknown bank, missing Actual name, review-only bank, ambiguous/overlapping
  rules, empty match conditions, and invalid suffixes. The server remains the validation authority.
- Change review: “Review changes” runs the structured preview and shows human-readable changes plus
  safe issues. A read-only YAML source disclosure is available for transparency, never editing.
- Save: sticky action bar with “Save and activate,” a confirmation dialog, and explicit persisted
  versus active revision state. Preserve drafts across validation errors. On external change,
  require explicit reload or deliberate reapply; never overwrite silently.
- Read-only deployment: show a clear banner with the writable-directory requirement; present the
  configuration readably rather than as a disabled textarea.
- Tests: add/remove/update mappings and rules, multiple rules per account, advanced predicates,
  overlap detection, unknown/missing names, comments/unknown fields preserved, preview invalidation,
  external revision conflict, save locking, read-only mode, and mobile single-column layout.

### 6.6 Bank registry

- Card/list view per bank: display name, immutable ID (copy), disposition (Import / Review only),
  sender aliases, message aliases, template references, and usage counts from account routes and
  templates.
- Alias chip editor with duplicate detection matching server normalization (case/whitespace); show
  which bank owns a duplicate before saving.
- Add bank dialog: slug ID with helper text (“stable; used by account routes and deduplication”), at
  least one sender, optional aliases/templates. ID is immutable after creation.
- Remove bank only when unreferenced; otherwise explain the exact references and offer navigation.
- Optional “Check a sender” tester using the same source-resolution code, showing
  supported/review/discarded without enqueueing.
- Every change goes through the structured preview/validation/save path because bank edits can
  invalidate account routes and template references.
- Tests: duplicate normalized aliases, unknown template reference, referenced-bank removal, ID
  immutability, disposition change preview, comment preservation, and save conflict.

### 6.7 Recognition grammar

This is the highest-risk editable surface. Build a read-only grammar explorer first, then enable
editing only behind its own opt-in and regression gate.

- Left navigation groups: ignored reasons, transaction kinds, shared fields, templates. Each group
  shows rule count and effective order.
- Rule cards show the value/field, regex source in monospace, flags, and order controls. Ordering is
  semantic (ignored, kind precedence, extractor order), so make drag/reorder explicit and test it.
- Add/edit rule dialog:
  - Compile the regex before accepting.
  - Enforce the existing named captures (`value`, or `amount`/`currency` for `foreign`).
  - Validate unique flags, non-empty patterns, template IDs, required shared fields, and bank
    template references.
- Live SMS lab: sender, message, received time, and “Test with draft.” Run the candidate through the
  real `parseSms` path via `POST /management/config/test-message`; show ignored reason, kind,
  extracted fields, or review reason. It must never enqueue or import.
- Template editor: ID, match patterns, kind, field overrides, required fields, and bank associations.
- Preview runs a fixed sample corpus (the existing parser fixtures, including Arabic messages) and
  reports outcome changes before save. Do not bump `PARSER_REVISION` from the UI; it remains a code
  release decision.
- Save uses the same atomic activation and multi-file validation. A failed candidate leaves the
  active runtime untouched.
- Tests: regex/named-capture/flags validation, order changes, template references, Arabic and English
  samples, candidate-vs-active corpus diff, save/activation, conflict handling, and a full parser
  regression run.

### 6.8 Tasker and inbox checkpoint

- Guided “Connect your phone” screen with three clear parts: restricted key, service origin and
  project download, checkpoint.
- Key:
  - Generate/replace requires a consequence dialog; show the new key once with copy and download.
  - Never persist the key in browser storage, URLs, or logs. Clear it when leaving the screen.
  - Offer “Download configured Tasker project” after a valid origin and current key; preserve the
    existing XML export security and filename.
- Origin: URL input with inline validation and a short explanation of HTTPS/path/credential rules.
- Checkpoint:
  - Show local time, UTC, and row ID in a readable definition list.
  - Edit in a dialog using device-local `datetime-local`; show consequences for forward/backward
    moves and the current seven-day first-use default.
  - Preserve the exact expected `(date, rowId)` tuple and handle conflicts by reloading the latest
    checkpoint, never overwriting.
  - Viewing, exporting, or rotating never initializes or moves the checkpoint; state this in the UI.
- Tests: one-time reveal, no storage, download, invalid/future dates, time-zone conversion, stale
  checkpoint conflict, and read-only/export states.

## 7. Test-first delivery plan

Each phase begins with failing tests that describe the intended UI or model behavior. Existing
assertions about security, privacy, races, and persistence are never deleted; update selectors and
labels only where the UX intentionally changes.

### Phase 0 — Harness and model extraction

**Tests first**

- Pure view-model tests for status labels/counts, event filter encoding, payee row/state summaries,
  config issue presentation, and direction/format helpers.
- Static asset route tests: allowlisted modules only, correct content type, no traversal, no-store.
- Keep `test/management.test.ts` green throughout.

**Work**

- Extract `browser.ts` into `web/` modules behind the existing entry.
- Add typed API client, router, toast/error primitives, and `el`/`UserText` helpers.
- Keep the current UI visually working during extraction.

**Exit:** no behavior change; `npm run check`, build, and current web smoke pass.

### Phase 1 — Shell, sign-in, components, responsive navigation

**Tests first**

- Browser scenarios for login/logout/session expiry, hash deep links/back, mobile navigation, focus
  return, dialog focus trap, and reduced motion.
- Overflow checks at 320×568, 390×844, 768×1024, and 1280×800.

**Work**

- New design tokens, base styles, shell, navigation, sign-in, toasts, dialogs, skeletons, empty
  states, and the component inventory.
- Replace `window.confirm`; add error mapping and duplicate-submit protection.

**Exit:** all routes reachable on desktop/mobile with no horizontal scroll; keyboard-only sign-in and
navigation pass; no external requests.

### Phase 2 — Overview dashboard

**Tests first**

- Status fixtures for ready/paused/disconnected/changing/migration-pending; polling visibility;
  reconnect double-submit; 401 redirect; sanitized errors.

**Work**

- Build the overview with readiness, queue summary, connection card, refresh/reconnect actions, and
  last-updated state.

**Exit:** the overview communicates why imports are or are not running without reading JSON; mobile
layout is single-column and touch targets pass.

### Phase 3 — SMS audit

**Tests first**

- List/filter/date/enrichment/cursor flows, detail sections, escaping, privacy, Arabic mixed text,
  long strings, drawer keyboard behavior, and 401.

**Work**

- Desktop table/mobile cards, filter sheet, detail drawer, timeline, parsed summary, raw disclosures.

**Exit:** no SMS body in summary responses or URLs; `<script>` payloads render as text; existing
privacy assertions pass.

### Phase 4 — Payees

**Tests first**

- Search with Arabic accents/normalization, inline category/tag save, optimistic rollback, revision
  conflict, link/unlink, conflict resolution, suggestion action, pagination, read-only/disconnected
  state, and mobile cards.

**Work**

- Interactive table/card list, inline editors, inspector, link/separate flows, conflict cards,
  suggestion action, and attention filtering if the additive API is approved.

**Exit:** all current payee business outcomes remain; no lost draft on conflicts; no raw descriptor
in URLs; mobile editing works without a table scroll.

### Phase 5 — Account routing

**Tests first**

- Server tests for patch application, allowlisted paths, comment/unknown-field preservation, issue
  paths, revision conflicts, atomic activation, and equivalence with a manual YAML edit plus restart.
- Browser scenarios for add/edit/remove mapping and rules, advanced predicates, validation issues,
  preview invalidation, external edits, save locking, read-only mode, and mobile.

**Work**

- Add structured model/preview/save endpoints over `ConfigEditor`.
- Add catalog refresh and issue objects.
- Build grouped account cards, rule editor, chip inputs, meaningful change review, and confirmation
  flow.

**Exit:** an operator can perform every supported account-routing edit without seeing editable YAML;
the resulting file preserves comments/unrelated fields; no text editor is required.

### Phase 6 — Bank registry

**Tests first**

- Patch/validation tests for banks, duplicate aliases after normalization, template references,
  referenced deletion, disposition changes, and multi-file activation.
- Browser flows for add/edit/remove, chips, ID immutability, and sender lookup.

**Work**

- Extend `ConfigEditor` to structured writes for `banks.yaml` under an explicit opt-in.
- Build the registry UI and optional sender tester.

**Exit:** bank edits validate against accounts and parsing, cannot orphan references, and preserve
the file's unknown structures.

### Phase 7 — Recognition grammar

**Tests first**

- Compile validation (named captures, flags, empty/duplicate rules), order semantics, template
  references, candidate parse behavior on English/Arabic fixtures, corpus diff, and save activation.
- Browser scenarios for rule editing/reordering, live tester, template editing, preview, conflicts,
  and read-only fallback.

**Work**

- Build the grammar explorer and editor behind its opt-in; add the test-message endpoint.
- Treat the read-only explorer as a valid fallback if the editing gate cannot be met safely.

**Exit:** no parser regression; UI cannot save an invalid grammar; existing automatic processing
remains untouched; parser revision is not changed by a configuration save.

### Phase 8 — Tasker setup

**Tests first**

- Key reveal/rotation, no browser storage, export download, origin validation, checkpoint
  local-time/UTC display, conflict handling, and no checkpoint mutation on view/export.

**Work**

- Guided layout, one-time secret dialog, export flow, checkpoint dialog with presets/consequences.

**Exit:** the phone setup can be completed from the management UI without exposing or persisting
keys beyond the intended one-time view.

### Phase 9 — Hardening and release

- Accessibility audit (dev-only `@axe-core/playwright` plus manual keyboard/screen-reader checks)
  on every route.
- RTL/Arabic fixture pass, zoom/text-scale checks, dark mode contrast.
- Performance check: no polling while hidden, abort stale requests, no bundle/font regressions.
- Update `docs/management.md` and the README to describe the new UI and any per-file edit flags.
- Add the browser smoke job to CI with no live services.
- Remove or keep the old text-editing endpoints as compatibility surface; stop advertising manual
  YAML editing as the primary workflow.

## 8. Verification matrix

### Automated gates

- `npm run check` remains the required gate: Prettier, zero-warning ESLint, strict TypeScript, Vitest.
- `npm run build` must succeed with the new browser modules.
- `npm run test:web` (Playwright, fake Actual, in-memory SQLite, no live credentials) must cover:
  - authentication, origin, session revocation, throttling, and expired sessions;
  - status, audit privacy, payee workflows, structured routing, bank/parsing gates, Tasker;
  - stale previews, conflict recovery, save locking, read-only deployments;
  - `<script>` escaping, Arabic bidi, long strings, and mobile overflow.
- CI adds a separate browser job after build: install Chromium with dependencies, run the smoke
  suite. The main `npm run check` job remains service-free.
- Optional dev-only visual snapshots for key routes at desktop/mobile and light/dark. Use them as
  review aids; semantic assertions remain authoritative.

### Manual/exploratory checks

- Keyboard-only pass: skip link, navigation, combobox, dialog, drawer, table editing, save/cancel.
- Screen reader pass for status announcements and conflict errors.
- 320px width, 200% zoom, landscape phone, and virtual-keyboard behavior.
- Arabic-only, English-only, and mixed-content fixtures in tables, detailed SMS, chips, and dialogs.
- Dark mode contrast and reduced motion.
- Deployment modes: management disabled, enabled read-only, account editing enabled, bank/parsing
  editing enabled.

### Regression equivalence

For account/bank/parsing edits, prove that a browser edit produces the same resolved configuration
as an equivalent manual YAML edit followed by restart. Keep a revision-conflict test that writes the
file externally during a browser draft.

## 9. Risks and mitigations

| Risk                                                  | Mitigation                                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| YAML patch editing loses comments or unrelated fields | Allowlisted AST patches, fixture-based round-trip tests, refuse unsafe candidates, keep read-only source disclosure.       |
| Structured validation maps errors to the wrong field  | Add issue paths/codes beside messages; test each rule failure; server remains authority.                                   |
| Bank/grammar editing changes recognition unexpectedly | Separate opt-ins, read-only fallback, fixture corpus diff, full parser tests, no UI-triggered parser revision bump.        |
| Edited regex causes runaway matching                  | Operator-only surface, compile/validation limits, bounded test corpus, explicit warnings, and no untrusted input path.     |
| Mobile tables become cramped or scroll horizontally   | Card fallback below 640px; per-route overflow assertions; no hover-only actions.                                           |
| Arabic text reorders in mixed strings                 | `UserText` direction-per-line, `<bdi>` isolation, logical CSS, dedicated fixtures and manual review.                       |
| Browser smoke becomes slow/flaky                      | Keep one isolated fake-Actual harness, split flows into helpers, semantic selectors, deterministic data, no live services. |
| UI scope drifts into transaction review or dashboards | Enforce non-goals and phase gates; phase 6 of the adoption plan remains separate.                                          |
| Draft loss on conflicts                               | Preserve drafts in memory, make reload/reapply explicit, never overwrite after a failed save silently.                     |
| CSP or external asset issues                          | No CDN/font/icon dependencies; self-host anything optional; keep scripts/styles same-origin and inline-free.               |
| Accessibility regressions from custom widgets         | Use native controls where possible, follow ARIA APG combobox/dialog patterns, automated axe checks + keyboard tests.       |

## 10. Definition of done

- Every existing management workflow is available through the new UI with no YAML text editing.
- Files remain the sole configuration authority; browser edits are revision-checked, validated,
  atomically saved, comment-preserving where possible, and recoverable.
- Headless operation, engine behavior, import identity, privacy, and security invariants are
  unchanged.
- Payees, routing, banks, recognition, status, audit, and Tasker each have a domain-appropriate
  interface with clear empty/loading/error/conflict states.
- Keyboard, screen-reader, mobile, dark-mode, and Arabic/bidi acceptance checks pass.
- The full `npm run check`, build, and isolated browser smoke pass in CI.
- Documentation describes the actual implemented behavior and no longer presents raw YAML as the
  primary editing experience.
