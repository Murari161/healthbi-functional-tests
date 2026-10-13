import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, reportUrl, runDir } from '../src/config';
import { discoverFilters, buildMatrix } from '../src/filters';
import { attachTokenCapture, waitForToken } from '../src/auth-capture';
import { classifyReport } from '../src/classify';
import { componentStatesFromReport, fetchReportJson, type ComponentRow } from '../src/components';
import { scanControls, type ControlsScan } from '../src/controls-scan';
import { checkDownloads, type DownloadCheck } from '../src/downloads';
import { checkFeedback, type FeedbackCheck } from '../src/feedback';
import { loadReportPage, SessionExpiredError, within } from '../src/resilience';
import { standardsFromReport } from '../src/standards';
import {
  appendResult,
  appendComponentResult,
  appendDownloadResult,
  appendFeedbackResult,
  appendStandardsResult,
  slug,
} from '../src/summary';
import type { FilterCombo, ReportClassification, ReportListItem, ResultRow } from '../src/types';

/**
 * Post-deploy functional audit. For every report the normal user can see, apply
 * a filter matrix (OFAT + pairwise) through the real UI and record, per combo:
 *   - a combo-level roll-up (summary.csv)
 *   - a per-component state grid (components.csv): each component ok/empty/broken,
 *     or "not loaded" when the report page itself never arrived (even on a retry,
 *     including when the site is unreachable and the app shows "You are offline")
 *   - a full-page screenshot, plus one per broken component
 * Once per report (on the first combo that loads): downloads, feedback, standards.
 * A report test FAILS only on ❌ broken; ⚪ empty is recorded, not failed. A combo
 * that goes wrong is recorded and the run carries on with the remaining combos;
 * after 3 unreachable combos in a row the rest of the report is skipped, and an
 * expired session stops the run with a clear message.
 */

function loadReports(): ReportListItem[] {
  if (!existsSync(config.reportsCachePath)) {
    throw new Error(
      `Missing ${config.reportsCachePath}. Run \`npm run prepare-run\` first ` +
        `(or just \`npm run qa\`, which runs it for you).`,
    );
  }
  const all: ReportListItem[] = JSON.parse(readFileSync(config.reportsCachePath, 'utf8'));
  if (config.scope === 'all') return all;
  const wanted = new Set(config.scope.split(',').map((s) => s.trim()).filter(Boolean));
  return all.filter((r) => wanted.has(r.id));
}

const reports = loadReports();

/** What the DOM classifier reports when the page stops answering reads. */
const UNRESPONSIVE: ReportClassification = {
  state: 'broken',
  totalComponents: 0,
  okCount: 0,
  emptyCount: 0,
  brokenComponents: ['REPORT: page unresponsive — DOM checks timed out (20s)'],
  leakedSamples: [],
  leakedPlaceholders: false,
  neverRendered: false,
};

const firstLine = (e: unknown) => String(e).split('\n')[0].slice(0, 200);

for (const report of reports) {
  test(`report: ${report.id}`, async ({ page }) => {
    const getToken = attachTokenCapture(page);

    // Capture the report JSON the browser itself fetches (the payload that renders
    // the page) so we get per-component states without an extra server fetch.
    let capturedReport: any = null;
    let capturedUrl = '';
    page.on('response', async (resp) => {
      try {
        if (resp.request().method() !== 'GET' || !resp.url().includes('/api/report/') || !resp.ok()) return;
        const j = await resp.json();
        if (j && Array.isArray(j.sections)) {
          capturedReport = j;
          capturedUrl = resp.url();
        }
      } catch {
        /* non-JSON / unavailable body — ignore */
      }
    });

    // Use the captured response only when its URL carries this combo's filters;
    // otherwise re-fetch (avoids using the filterless metadata call or a stale one).
    const capturedMatches = (params: Record<string, string>): boolean => {
      if (!capturedReport) return false;
      const u = decodeURIComponent(capturedUrl);
      for (const [k, v] of Object.entries(params)) {
        if (!u.includes(`${k}=`) || !u.includes(v)) return false;
      }
      return true;
    };

    // Prime: load the report once so the app authenticates (gives us a token) and
    // so we can read its filter definitions.
    const primeUrl = reportUrl(report.id, {});
    const prime = await loadReportPage(page, primeUrl, {
      navTimeoutMs: config.navTimeoutMs,
      waitForRender: () => waitForReportRender(page),
      onRetry: (why) => console.log(`[${report.id}] ↻ ${why} — retrying once`),
    });
    if (!prime.ok) {
      appendResult({
        timestamp: new Date().toISOString(),
        reportId: report.id,
        comboLabel: 'baseline',
        effective: '',
        varies: 'baseline',
        state: 'broken',
        totalComponents: 0,
        okCount: 0,
        emptyCount: 0,
        brokenComponents: `page never loaded (2 attempts): ${prime.error}`,
        leakedPlaceholders: false,
        url: primeUrl,
        screenshot: '',
        navAttempts: prime.attempts,
        pageLoaded: false,
      });
    }
    expect(prime.ok, `Report page never loaded (2 attempts): ${prime.error}`).toBe(true);
    const token = await waitForToken(page, getToken);
    test.skip(!token, 'No auth token captured — session may have expired; re-run `npm run prepare-run`.');

    const filters = await discoverFilters(page, token, report.id);
    const matrix = buildMatrix(filters);
    // Scale the per-report timeout to the matrix size so a rich matrix on a heavy
    // report isn't aborted mid-run (each combo may wait up to renderTimeoutMs plus
    // overhead). The test still finishes as soon as the combos do — this is only a
    // ceiling, not a fixed wait. The flat buffer covers the once-per-report
    // download + feedback checks.
    test.setTimeout((matrix.length + 2) * (config.renderTimeoutMs + 45_000) + 7 * 60_000);
    console.log(`▶ ${report.id}: ${matrix.length} filter combination(s)`);

    const brokenCombos: string[] = [];
    // The latest component list seen on a page that loaded — used to mark each
    // component "not loaded" when a combo's page never arrives.
    let refComps: ComponentRow[] = capturedReport ? componentStatesFromReport(capturedReport) : [];
    let onceChecksDone = false;
    let notLoadedInARow = 0;

    /** Every declared filter, valued from the app's own data request (so app defaults show); '—' = unconstrained. */
    const effectiveOf = (combo: FilterCombo, dataUrl: string): string => {
      let q: URLSearchParams | null = null;
      try {
        if (dataUrl) q = new URL(dataUrl).searchParams;
      } catch {
        /* ignore */
      }
      return filters
        .map((f) => {
          const p = f.def.paramName;
          return `${p}=${q?.get(p) ?? combo.params[p] ?? '—'}`;
        })
        .join(' & ');
    };

    /** The user would see no report at all: every component of the combo is "not loaded". */
    const recordNotLoaded = (combo: FilterCombo, url: string, reason: string, attempts: number) => {
      const ts = new Date().toISOString();
      appendResult({
        timestamp: ts,
        reportId: report.id,
        comboLabel: combo.label,
        effective: effectiveOf(combo, ''),
        varies: combo.varies,
        state: 'broken',
        totalComponents: refComps.length,
        okCount: 0,
        emptyCount: 0,
        brokenComponents: reason,
        leakedPlaceholders: false,
        url,
        screenshot: '',
        navAttempts: attempts,
        pageLoaded: false,
      });
      for (const c of refComps) {
        appendComponentResult({
          timestamp: ts,
          reportId: report.id,
          comboLabel: combo.label,
          varies: combo.varies,
          sectionIndex: c.sIdx,
          componentIndex: c.cIdx,
          section: c.section,
          component: c.title,
          type: c.type,
          state: 'not_loaded',
          error: `component not loaded — ${reason}`,
        });
      }
      brokenCombos.push(`[${combo.label}] ${reason}`);
    };

    /** Run one combo, recording its rows; returns whether the page loaded, plus a progress line. */
    const runCombo = async (
      combo: FilterCombo,
      tag: string,
      rec: { written: boolean },
    ): Promise<{ loaded: boolean; line: string }> => {
      const url = reportUrl(report.id, combo.params);
      capturedReport = null;
      capturedUrl = '';
      const nav = await loadReportPage(page, url, {
        navTimeoutMs: config.navTimeoutMs,
        waitForRender: () => waitForReportRender(page),
        onRetry: (why) => console.log(`${tag} ↻ ${why} — retrying once`),
      });
      if (!nav.ok) {
        recordNotLoaded(combo, url, `page never loaded (2 attempts): ${nav.error}`, nav.attempts);
        rec.written = true;
        return { loaded: false, line: `✗ not loaded after 2 attempts — ${nav.error}` };
      }

      await triggerLazyComponents(page); // render lazy charts/maps for the screenshot

      // Report-level DOM signals (what the user sees): timeout/error box, leaked {{}}.
      const dom = await within(classifyReport(page), 20_000, UNRESPONSIVE);

      // Per-component states from the report JSON the browser fetched (verified to
      // match this combo); else re-fetch with the token.
      const rep = capturedMatches(combo.params)
        ? capturedReport
        : await fetchReportJson(page, token, report.id, combo.params);
      const comps = rep ? componentStatesFromReport(rep) : [];
      if (comps.length > 0) refComps = comps;
      const brokenComps = comps.filter((c) => c.state === 'broken');
      const okComps = comps.filter((c) => c.state === 'ok');
      const emptyComps = comps.filter((c) => c.state === 'empty');

      const reportLevel =
        dom.neverRendered ||
        dom.leakedPlaceholders ||
        dom.brokenComponents.some((t) => t.startsWith('REPORT:'));
      const noData = !rep;

      let state: 'ok' | 'empty' | 'broken';
      if (brokenComps.length > 0 || reportLevel || noData) state = 'broken';
      else if (okComps.length > 0) state = 'ok';
      else state = 'empty';

      const brokenTitles = [
        ...brokenComps.map((c) => c.title),
        ...dom.brokenComponents.filter((t) => t.startsWith('REPORT:')),
        ...(dom.leakedPlaceholders ? [`leaked placeholder → ${dom.leakedSamples.join(' | ')}`] : []),
        ...(noData ? ['(report fetch failed)'] : []),
      ];

      // Screenshots. Full page content via the sections container (captures its
      // whole height — the app scrolls an inner container, so fullPage misses it).
      const comboSlug = slug(combo.label);
      const fullShot = join(runDir(), 'screenshots', `${slug(report.id)}__${comboSlug}.png`);
      await page
        .locator('#sections-container')
        .screenshot({ path: fullShot })
        .catch(async () => {
          await page.screenshot({ path: fullShot, fullPage: true }).catch(() => {});
        });
      // One screenshot per broken component (the rendered "Failed to load data" cards).
      const errorCards = page.locator('#sections-container .component-error');
      const nErr = await within(errorCards.count().catch(() => 0), 10_000, 0);
      for (let i = 0; i < nErr; i++) {
        const name =
          (await errorCards.nth(i).locator('.component-error-title').textContent().catch(() => '')) ||
          `component_${i}`;
        const cshot = join(
          runDir(),
          'screenshots',
          'components',
          `${slug(report.id)}__${comboSlug}__${slug(name)}.png`,
        );
        await errorCards.nth(i).screenshot({ path: cshot }).catch(() => {});
      }

      const ts = new Date().toISOString();
      const effective = effectiveOf(combo, capturedUrl);
      const row: ResultRow = {
        timestamp: ts,
        reportId: report.id,
        comboLabel: combo.label,
        effective,
        varies: combo.varies,
        state,
        totalComponents: comps.length,
        okCount: okComps.length,
        emptyCount: emptyComps.length,
        brokenComponents: brokenTitles.join(' | '),
        leakedPlaceholders: dom.leakedPlaceholders,
        url,
        screenshot: fullShot,
        navAttempts: nav.attempts,
        pageLoaded: true,
      };
      appendResult(row);
      rec.written = true;

      for (const comp of comps) {
        appendComponentResult({
          timestamp: ts,
          reportId: report.id,
          comboLabel: combo.label,
          varies: combo.varies,
          sectionIndex: comp.sIdx,
          componentIndex: comp.cIdx,
          section: comp.section,
          component: comp.title,
          type: comp.type,
          state: comp.state,
          error: comp.error,
        });
      }

      // Once per report, on the first combo whose page loaded with components
      // (normally the baseline) — the wiring checked here doesn't vary by filter.
      if (!onceChecksDone && comps.length > 0) {
        onceChecksDone = true;

        // Design-standards warnings (e.g. unlabeled chart axes). Warnings only —
        // recorded and shown, but they never fail the test.
        for (const iss of standardsFromReport(rep)) {
          appendStandardsResult({
            timestamp: new Date().toISOString(),
            reportId: report.id,
            section: iss.section,
            component: iss.component,
            type: iss.type,
            rule: iss.rule,
            detail: iss.detail,
          });
        }

        // One read-only pass mapping each component's header controls (Feedback,
        // downloads) to that exact component; shared by both checks below.
        let scan: ControlsScan | undefined;
        let scanError = '';
        try {
          scan = await scanControls(page);
        } catch (e) {
          scanError = firstLine(e);
        }

        // Downloads: does each component HAVE a download button, and does each
        // button found produce a real, non-empty file?
        let checks: DownloadCheck[];
        try {
          if (!scan) throw new Error(scanError);
          checks = await checkDownloads(page, comps, scan);
        } catch (e) {
          checks = [
            {
              kind: '',
              label: 'download check',
              ok: false,
              filename: '',
              bytes: 0,
              error: `download check could not run: ${firstLine(e)}`,
              state: 'failed',
              section: '',
              component: '',
              type: '',
            },
          ];
        }
        const dlProblems: string[] = [];
        for (const chk of checks) {
          appendDownloadResult({ timestamp: new Date().toISOString(), reportId: report.id, ...chk });
          if (chk.state === 'failed') dlProblems.push(`${chk.label} — ${chk.error}`);
          else if (chk.state === 'missing' && config.downloadMissingFails)
            dlProblems.push(`no download button on "${chk.component}" — ${chk.error}`);
        }
        if (dlProblems.length > 0) brokenCombos.push(`[downloads] ${dlProblems.join('; ')}`);

        // Feedback: every visual should carry its button; the form must open,
        // show its scope, load "Previous feedback" and close. NEVER submitted.
        let fbChecks: FeedbackCheck[];
        try {
          if (!scan) throw new Error(scanError);
          fbChecks = await checkFeedback(page, comps, scan);
        } catch (e) {
          fbChecks = [
            {
              check: 'modal',
              scope: 'report',
              section: '',
              component: '',
              type: '',
              state: 'broken',
              detail: `feedback check could not run: ${firstLine(e)}`,
            },
          ];
        }
        const fbProblems: string[] = [];
        for (const fb of fbChecks) {
          appendFeedbackResult({ timestamp: new Date().toISOString(), reportId: report.id, ...fb });
          const label = `${fb.scope}${fb.component ? ` "${fb.component}"` : fb.section ? ` [${fb.section}]` : ''}`;
          if (fb.state === 'broken') fbProblems.push(`${label}: ${fb.detail}`);
          else if (fb.state === 'missing' && config.feedbackMissingFails) fbProblems.push(`${label}: ${fb.detail}`);
        }
        if (fbProblems.length > 0) brokenCombos.push(`[feedback] ${fbProblems.join('; ')}`);
      }

      if (state === 'broken') {
        const detail = noData
          ? 'report fetch failed'
          : reportLevel && brokenComps.length === 0
            ? dom.neverRendered
              ? 'never rendered'
              : dom.leakedPlaceholders
                ? `leaked: ${dom.leakedSamples.join(' | ')}`
                : dom.brokenComponents.filter((t) => t.startsWith('REPORT:')).join(', ')
            : `failed: ${brokenComps.map((c) => c.title).join(', ')}`;
        brokenCombos.push(`[${combo.label}] ${detail}`);
      }

      const icon = state === 'ok' ? '✓' : state === 'empty' ? '○' : '✗';
      const counts = `${okComps.length} ok · ${emptyComps.length} empty · ${brokenComps.length} broken`;
      return { loaded: true, line: `${icon} ${state} — ${counts}${nav.attempts > 1 ? ' · ↻ loaded on the 2nd try' : ''}` };
    };

    for (const [i, combo] of matrix.entries()) {
      const tag = `[${i + 1}/${matrix.length}]`;
      if (notLoadedInARow >= 3) {
        // The site is down: don't spend ~2 minutes per combo proving it again.
        recordNotLoaded(combo, reportUrl(report.id, combo.params), 'skipped: the site was unreachable for 3 combinations in a row', 0);
        console.log(`${tag} ⏭ ${combo.label} — skipped, site unreachable for 3 combinations in a row`);
        continue;
      }
      const t0 = Date.now();
      const rec = { written: false };
      console.log(`${tag} ▶ ${combo.label}`);
      let line: string;
      let loaded = true;
      try {
        ({ line, loaded } = await runCombo(combo, tag, rec));
      } catch (e) {
        if (e instanceof SessionExpiredError) throw e; // nothing after this can be judged
        // Anything unexpected: record THIS combo as broken and carry on with the rest.
        const msg = firstLine(e);
        if (!rec.written) {
          appendResult({
            timestamp: new Date().toISOString(),
            reportId: report.id,
            comboLabel: combo.label,
            effective: effectiveOf(combo, capturedUrl),
            varies: combo.varies,
            state: 'broken',
            totalComponents: 0,
            okCount: 0,
            emptyCount: 0,
            brokenComponents: `combo aborted: ${msg}`,
            leakedPlaceholders: false,
            url: reportUrl(report.id, combo.params),
            screenshot: '',
          });
        }
        brokenCombos.push(`[${combo.label}] combo aborted: ${msg}`);
        line = `✗ aborted — ${msg}`;
        await page.goto('about:blank', { timeout: 10_000 }).catch(() => {});
      }
      notLoadedInARow = loaded ? 0 : notLoadedInARow + 1;
      console.log(`${tag} ${line} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }

    // Faithful gate: only ❌ broken fails the test; ⚪ empty is fine.
    expect(brokenCombos, `Broken under these filters:\n${brokenCombos.join('\n')}`).toEqual([]);
  });
}

/**
 * Wait until the report has finished loading: the app fills #sections-container
 * with `.skeleton` placeholders during its single /api/report fetch, then
 * replaces them with real sections (or a "No data" message). Timeout is generous
 * (config.renderTimeoutMs) to exceed the 30s per-component and 45s frontend limits.
 *
 * Skeletons inside `.chart-placeholder` don't count: those are lazy charts that
 * only render once scrolled into view (see triggerLazyComponents), not loading.
 */
async function waitForReportRender(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        if (document.querySelector('#kc-login, #kc-form-login')) return true; // sent to sign-in: stop waiting
        const sc = document.querySelector('#sections-container');
        if (!sc) return false;
        const loading = Array.from(sc.querySelectorAll('.skeleton')).some((el) => !el.closest('.chart-placeholder'));
        if (loading) return false;
        const txt = (sc as HTMLElement).innerText || '';
        if (/No data available|No data found/i.test(txt)) return true; // empty, but done
        return sc.children.length > 0; // real content rendered
      },
      undefined, // arg slot — options must be the THIRD parameter
      { timeout: config.renderTimeoutMs },
    )
    .catch(() => {});
  await page.waitForTimeout(400); // settle async transforms
}

/**
 * Render every lazy chart, the way a user scrolling down does. The report
 * scrolls inside .report-container (overflow-y:auto), not the window, so each
 * `.chart-placeholder` is scrolled into view directly — that's what fires the
 * app's IntersectionObserver. Without this, below-the-fold charts stay
 * skeletons: no chart, no Feedback/PNG buttons, skeletons in screenshots.
 */
async function triggerLazyComponents(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const left = await within(
      page
        .evaluate(async () => {
          const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
          const sel = '#sections-container .chart-placeholder';
          for (const el of Array.from(document.querySelectorAll(sel))) {
            el.scrollIntoView({ block: 'center' });
            await sleep(150);
          }
          return document.querySelectorAll(sel).length;
        })
        .catch(() => 0),
      20_000,
      -1, // page stopped answering — give up on lazy rendering for this combo
    );
    if (left <= 0) break;
  }
  await within(
    page
      .evaluate(() => {
        document.querySelector('.report-container')?.scrollTo(0, 0);
        window.scrollTo(0, 0);
      })
      .catch(() => {}),
    5_000,
    undefined,
  );
  await page.waitForTimeout(800); // let Chart.js/Leaflet finish
}
