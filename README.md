# Health BI — Report Functional Tests

A **standalone** post-deployment functional-test suite for the Health BI report
browser. It drives the **live web UI as a normal user** (Playwright + Chromium),
applies a **per-report filter matrix**, and records which report components
**load / are empty / fail** — exactly the manual QA task of "click different
filters on each report and see what breaks", automated.

It runs **entirely against the deployed site**. It never touches the database or
any backend internals — it only sees what a logged-in user's browser renders.

```
functional-tests/            ← this folder (its own git repo, beside dwh_visualization)
├─ scripts/prepare.ts        login once + cache the report list
├─ src/
│  ├─ config.ts              env/config + deep-link URL builder
│  ├─ types.ts               shared types
│  ├─ filters.ts             discover each report's filters + build the matrix
│  ├─ classify.ts            read the DOM → ok / empty / broken
│  └─ summary.ts             incremental CSV + JSONL writer
├─ tests/report-audit.spec.ts  the audit (one test per report)
├─ playwright.config.ts
└─ .env.example              copy to .env and fill in
```

## Setup

```bash
cd "D:/Data Warehouse Work/dwh_visualization/functional-tests"
npm install
npm run install-browser        # downloads Chromium
cp .env.example .env           # then edit .env
```

Fill in `.env`:
- `HEALTHBI_BASE_URL` / `HEALTHBI_API_BASE` — the live site (defaults point at prod:
  `…/report-browser` and `…/report-browser/api`).
- **Login** — two options (either way, use a **dedicated normal, non-admin QA user**
  so the audit stays faithful to what real users see):
  1. **Manual (recommended):** leave `HEALTHBI_USER`/`HEALTHBI_PASS` blank.
     `prepare-run` opens a browser and **waits for you to sign in by hand** (MFA is
     fine). No password stored anywhere.
  2. **Automated:** set both; the Keycloak form is filled for you. `.env` is
     gitignored and creds are only typed into the Keycloak page.

## Run — exact steps

All commands are run from this folder:
`D:/Data Warehouse Work/dwh_visualization/functional-tests`

**Step 1 — one-time setup** (only the first time):
```bash
npm install
```
```bash
npm run install-browser
```
```bash
cp .env.example .env
```
Leave `HEALTHBI_USER` / `HEALTHBI_PASS` blank in `.env` for manual login (recommended).

**Step 2 — log in + cache the report list** (run once, and again whenever the session expires):
```bash
npm run prepare-run
```
A browser opens — sign in by hand. On success it prints `✓ Cached N reports`. If the
saved session is still valid it is reused and the window just flashes by (no login needed).

**Step 3 — run the audit.** One report first (good smoke test):
```bash
REPORT_SCOPE=community/wash-report npm test
```
A few reports:
```bash
REPORT_SCOPE="community/wash-report,Programs/Malaria/malaria-monthly-stock-status" npm test
```
ALL reports:
```bash
npm test
```

**Step 4 — view results:**
```bash
npm run report
```
Plus `results/summary.csv` (the component×filter grid) and `results/screenshots/`.

### Other commands
```bash
npm run probe        # quick auth check — confirms the saved session still works
npm run qa           # = prepare-run + audit ALL, in one go (re-opens login each run)
npm run qa:deep      # same as qa, but the full-factorial matrix
```
Env tweaks (prefix any `npm test`):
```bash
RENDER_TIMEOUT_MS=90000 npm test   # give heavy reports more time to load (default 60s)
MATRIX_MODE=deep npm test          # exhaustive filter combinations (default: one-at-a-time)
FEEDBACK_MISSING_FAILS=1 npm test  # fail a report when any component lacks its Feedback button
DOWNLOAD_MISSING_FAILS=1 npm test  # fail a report when any component lacks a download button
NAV_TIMEOUT_MS=60000 npm test      # give the report PAGE longer to arrive before the one retry (default 45s)
LOAD_SLOW_MS=15000 npm test        # colour load times amber from 15s (default 10s; red from LOAD_VERY_SLOW_MS, default 30s)
```
While it runs, each filter combination prints a progress line, e.g.
`[3/9] ✓ ok — 9 ok · 1 empty · 0 broken · shown in 5.5 s (app setup 4.5 s · server 0.3 s) (8.7s)`,
so you can always see where it is. The last figure is how long the suite spent on
that combination, checks included.

**Flow tip:** with manual login, prefer `npm run prepare-run` **once**, then `npm test`
as often as you like — it reuses the saved session. Use `npm run qa` only if you want it
to log in every time.

## What it checks (per report × filter combo)

| State | Meaning | Fails the test? |
|-------|---------|-----------------|
| ✅ `ok` | components rendered with data | no |
| ⚪ `empty` | rendered, but no data for this filter | **no** — a real user-visible state, reported as-is |
| ❌ `broken` | "Failed to load data" card, leaked `{{placeholder}}`, or never rendered | **yes** |
| 🟧 `not loaded` | the report **page itself never arrived** — every component in that combo is marked "component not loaded" | **yes** (as a report-level broken combo) |

The faithful principle: we report **what the user actually sees** and only flag
genuine breakage — we never massage an empty result into a pass.

**Page loads.** If a report page doesn't arrive within 45s (`NAV_TIMEOUT_MS`), it is
retried **once** — what a user does by pressing refresh — and the combo is marked
**↻** in the grid so the hiccup stays visible. If the retry fails too, the combo's
components are recorded as **not loaded** and the run carries on with the remaining
combos (one bad combo never stops the rest of the report). The same applies when the
site is unreachable and the app shows its own "You are offline" page or message: that
is not the report, so it is retried and then recorded as not loaded — never judged as
broken. After 3 unreachable combinations in a row, the rest of that report is skipped
(recorded as not loaded, "skipped"). If the sign-in page appears, the session has
expired: the run stops and asks you to run `npm run prepare-run`.

**Load time.** Every combination is timed as the user experiences it: from opening the
report until no loading placeholders are left. The time is split into parts that add up:

| Part | What it is |
|------|------------|
| page arrived | the report page itself reaches the browser |
| app setup | the app's own calls before it asks for the data: sign-in check, report list, report details, filter dropdown lists. The slowest of these is named, e.g. `filters/regions 1.3 s` |
| server | the app's **one** data request for all components, from sent to the first byte back. The server runs the component queries together, so this is roughly the slowest component's query |
| download | receiving that data |
| drawing | the browser drawing the charts and tables |

Shown in the grid as two rows, **load time** and **server time** (hover a cell for the
breakdown), as a **Load time** column in the combination key, and as a ⏱ line per report.
Times from 10s are amber and from 30s red (`LOAD_SLOW_MS` / `LOAD_VERY_SLOW_MS`). A slow
report is reported, never failed. The figures are also in `summary.csv` (`loadMs`,
`pageMs`, `setupMs`, `slowestSetupCall`, `serverMs`, `downloadMs`, `drawMs`).

**On-screen checks.** On every combination, the values on screen are read the way a
user sees them, with nothing opened or drilled into: the table rows on show (the
table's current page), KPI card values, and the values each chart drew. Three simple
things are flagged:

| Flag | When |
|------|------|
| broken text | `NaN`, `undefined`, `Infinity`, `null` or `[object Object]` shown as a value or text |
| over 100% | a percentage above 100%, where the value is shown with "%" or its column/series name says "%" |
| negative number | a value below zero |

This is not a data-quality check: no source data is touched. To stay quiet on purpose,
columns, series and KPIs named as a change, difference or trend are skipped (they can be
negative or above 100%), so are "% of target" ones, and so are negatives on population
pyramids and waterfall charts (drawn that way). Coverage against population estimates
can exceed 100% for real; that is still flagged, as something to check. Flags show as
**!** in the grid (hover it), as a list under each report, and in `onscreen.csv`. They
never fail the test.

**Filter lists.** Each filter's dropdown list is loaded the way the app loads it. A list
that fails (e.g. HTTP 500) is broken for users and its filter can't be tested, so it
**fails the report** and is printed during the run; an empty list is recorded too
(unless it's empty only because a parent filter, e.g. district for facility, has no
value). Shown per report as "⚙ Filter lists" (values offered, or ✗ did not load), and in
`filters.csv`.

Charts and maps are drawn only when scrolled into view, so the suite scrolls each report
top to bottom with the mouse wheel, like a person, before reading or photographing it.

Once per report (on the baseline combo) it also checks:

| Check | What it does | Fails the test? |
|-------|--------------|-----------------|
| ⬇ **Downloads** | **availability:** every component should have a download button — one without is reported **missing** (amber, with the reason). **Function:** each button found is clicked inside its own component and must produce a non-empty file (table CSV / chart PNG) | yes, if a download fails; a *missing* button only fails with `DOWNLOAD_MISSING_FAILS=1` |
| 💬 **Feedback** | every component should carry a Feedback button (found without opening anything). Then the form is opened **once per scope** (report header, a section, a visual) through the real button: it must show the right scope (Report / Section / Visual), prefill the reporter, have the required fields and an enabled Submit, load "Previous feedback", and close. **The form is never submitted.** | yes, if the form misbehaves; a *missing* button is reported (amber) but only fails with `FEEDBACK_MISSING_FAILS=1` |
| ☰ **Standards** | house-style warnings, e.g. bar/line charts without labelled axes | no — warnings only |

**Platform checks** (same code on every report, so run once per run, before the reports,
shown as a table at the top of the results page). The report — `PLATFORM_REPORT`, else the
first report in scope — is opened with **every filter set to one real value**, then:

| Test | Passes when |
|------|-------------|
| Share button and menu | the menu opens with Download PDF, Save Offline, Copy Link, Email, WhatsApp |
| Email | the pre-filled email has the report title, and a link carrying every filter — captured, never sent |
| WhatsApp | the pre-filled message has the report title and a link carrying every filter — captured, never sent |
| Save Offline | the option switches to "Remove Offline Copy" and back (this browser only) |
| Download PDF | the server builds a real, non-empty PDF |
| Copy Link | the copied link carries every filter |
| Share button after Copy Link | the Share button keeps its icon after "Copied!" |
| Shared link opens the same view | the copied link, opened in a new tab, shows the same report with the same filters |

`PLATFORM_CHECKS=0` turns them off.

Known app gaps these checks report as missing: `text`, `kpi` and `cards` components
never render a Feedback button; `infobox`, `text`, `kpi`, `cards`, `choropleth` and `map`
components never get a download button. A component that failed to load shows an
error card with neither (reported as "–", not checkable).

## Defect list

After every run, everything the checks found is turned into a **defect list**: one row per
problem (not one per filter combination), at the top of the results page and in
`defects.csv` (opens in Excel; Jira can import it). Each row has an ID, severity, a
one-line summary for a ticket title, the report, section and component, the problem,
**what was seen**, the **expected result**, how often it was seen (e.g. "3 of 6
combinations"), the filters of the first view it was seen in, a **link that reproduces
it**, and the screenshot to attach. Owner is left blank for a person to assign.

| Severity | Problems |
|----------|----------|
| **High** | a component shows "Failed to load data" · `{{placeholder}}` text shown · broken text (NaN, undefined…) · the whole report failed (timeout box, fetch error) · the report page never loaded · a filter's dropdown list didn't load |
| **Medium** | no data in the default view, or in every combination tested · a percentage over 100% · a negative number · very slow (≥ `LOAD_VERY_SLOW_MS`) · the Feedback form misbehaves · a Share-menu check failed · a filter's dropdown list is empty · a view the suite couldn't finish (look at it by hand) |
| **Low** | a download that doesn't work · no download button · no Feedback button · a Share-menu warning |

Components that fail with the **same error in the same views** are one row, not one
each, and when one filter explains it the row says so — e.g. *21 components show "Failed
to load data" whenever facility is set — pq: column reference "facility" is ambiguous*.
"No data" is listed only when a component is empty in the **default view** (what users
see first) or in **every** combination tested. Empty for some filters only (e.g. a
district with no cases) is normal and not listed. When most of a report opens empty, it
is one report-level row (usually the default period has no data yet). Missing buttons
are grouped per component type. The scheme lives in `SEVERITY` in `src/defects.ts`.
`npm run report:html` rebuilds the list for the latest run.

## The filter matrix

Filters (built-in **and** custom) are discovered per report from
`GET /api/report/<id>`; real values come from the same endpoints the UI
dropdowns use. Tunable in `.env`:

- `MATRIX_MODE=ofat` (default) — **one filter at a time** (attributable) **plus
  pairwise** combos (every pair of filters at their first values, for interaction
  coverage). ~25–40 combos/report.
- `MATRIX_MODE=deep` — full factorial of the sampled values. Exhaustive, slow.
- `MAX_YEARS` / `MAX_MONTHS` / `MAX_DISTRICTS` (default **3**),
  `MAX_REGIONS` / `MAX_FACILITIES` / `MAX_CUSTOM_VALUES` (default **2**) —
  how many values to sample per filter.

Value sampling favors contrast (e.g. a data-rich vs. a sparse district) so the
❌-broken vs ⚪-empty distinction is meaningful. Facilities cascade from the
chosen district, like the UI.

## Output

Each run writes to its **own folder** `results/<report>__<timestamp>/` (e.g.
`results/echis-monthly-report__2026-10-08T08-19-50-845Z/`; `all__…` for a full
sweep). It's gitignored, and the exact path is printed at startup as `Output → …`.
A fresh folder per run means a new run never clobbers files you still have open
(e.g. `summary.csv` in Excel). `npm run report:html` targets the most recent run.
In that folder:
- **`<run-folder-name>.html`** (e.g. `wash-report-plus1__2026-10-08T….html`) — the
  **red/green grid**: per report, rows = components (grouped by section), columns
  = numbered filter combinations (**Combo 1…N**), cells 🟩 ok / 🟥 broken / ⬜ empty
  (hover a red cell for the error; hover a Combo header for its filters). The
  **Downloads** and **Feedback** columns give each component's ✓ ok / ✗ failed /
  missing status. Under each grid, the **Combination key** lists every combo with
  one column per filter — **bold** = set by the test, grey = the app's own
  default, — = not applied — plus its result. The **defect list** sits at the top.
  Open this first. Regenerate anytime with `npm run report:html`.
- **`defects.csv`** — the defect list (see [Defect list](#defect-list)).
- `onscreen.csv` (+ `.jsonl`) — one row per on-screen flag (report, combo, component, flag, detail).
- `filters.csv` (+ `.jsonl`) — one row per filter: did its dropdown list load, how many values, which ones were used.
- **`components.csv`** / `.jsonl` — the per-component drill-down: one row per
  (report, combo, section, component, type, **state**, error).
- `summary.csv` / `.jsonl` — the combo-level roll-up: one row per (report, combo)
  with the full effective filter set, state, component counts, and the titles of
  broken components.
- `downloads.csv`, `feedback.csv`, `standards.csv` (+ `.jsonl`) — one row per
  download control / feedback check / standards warning.
- `platform.csv` (+ `.jsonl`) — one row per platform check (test, what was found, pass/fail).
- `screenshots/<report>__<combo>.png` — the **whole report**, top to bottom, per combo
  (the window is stretched to the report's height for the picture, capped at 16,000 px).
- `screenshots/components/<report>__<combo>__<component>.png` — a screenshot of
  each **broken component** card.

Component states come from the report JSON the browser fetches (same payload that
renders the page): a component with `error` set → broken, with data → ok, else empty.

Plus Playwright's own `playwright-report/` (HTML) and `test-results/` (traces).

## Validated against the live site ✅

Confirmed on prod (2026-10-07): API base is `…/report-browser/api`; Keycloak realm
`MoH`, selectors `#username`/`#password`/`#kc-login`; component/error DOM and the
`filterDefinitions` shape match. The reports API requires a Keycloak **Bearer
token** (not cookies) — the suite captures it from the app's own requests.
