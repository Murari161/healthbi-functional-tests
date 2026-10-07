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
```

**Flow tip:** with manual login, prefer `npm run prepare-run` **once**, then `npm test`
as often as you like — it reuses the saved session. Use `npm run qa` only if you want it
to log in every time.

## What it checks (per report × filter combo)

| State | Meaning | Fails the test? |
|-------|---------|-----------------|
| ✅ `ok` | components rendered with data | no |
| ⚪ `empty` | rendered, but no data for this filter | **no** — a real user-visible state, reported as-is |
| ❌ `broken` | "Failed to load data" card, leaked `{{placeholder}}`, or never rendered | **yes** |

The faithful principle: we report **what the user actually sees** and only flag
genuine breakage — we never massage an empty result into a pass.

## The filter matrix

Filters (built-in **and** custom) are discovered per report from
`GET /api/report/<id>`; real values come from the same endpoints the UI
dropdowns use. Tunable in `.env`:

- `MATRIX_MODE=ofat` (default) — **one filter at a time** from a baseline, so a
  break is attributable to a specific filter value. ~10–14 loads/report.
- `MATRIX_MODE=deep` — full factorial of the sampled values. Exhaustive, slow.
- `MAX_YEARS` / `MAX_MONTHS` / `MAX_DISTRICTS` / `MAX_FACILITIES` /
  `MAX_CUSTOM_VALUES` — how many values to sample per filter (default 2).

Value sampling favors contrast (e.g. a data-rich vs. a sparse district) so the
❌-broken vs ⚪-empty distinction is meaningful. Facilities cascade from the
chosen district, like the UI.

## Output

Under `results/` (gitignored):
- `summary.csv` — the grid: one row per (report, filter combo) with state,
  component counts, and the **titles of any broken components**.
- `summary.jsonl` — same data, one JSON object per line.
- `screenshots/<report>__<combo>.png` — full-page screenshot of each combo.

Plus Playwright's own `playwright-report/` (HTML) and `test-results/` (traces).

## ⚠️ Validate against the live site (first run)

These were inferred from the frontend source and **must be confirmed** on the
real site during setup (easiest while logged in):

1. **API base path** — `HEALTHBI_API_BASE`. The app may serve APIs at
   `…/report-browser/api` rather than `…/api`. Confirm `GET …/reports` returns
   the report list.
2. **Keycloak login selectors** in `scripts/prepare.ts` (`#username`,
   `#password`, `#kc-login`). If they differ, just log in manually in the headed
   window — the script waits for you.
3. **Component DOM** in `src/classify.ts` — the error-card markup
   (`.component-error` / `.component-error-title`) and the per-component counting
   signals, in case the rendered structure differs from what's expected.

Everything is structured so these are one-line fixes once verified.
