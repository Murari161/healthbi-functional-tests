import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, reportUrl, runDir } from '../src/config';
import { discoverFilters, buildMatrix } from '../src/filters';
import { attachTokenCapture, waitForToken } from '../src/auth-capture';
import { classifyReport } from '../src/classify';
import { componentStatesFromReport, fetchReportJson } from '../src/components';
import { appendResult, appendComponentResult, initSummary, slug } from '../src/summary';
import type { ComponentResultRow, ReportListItem, ResultRow } from '../src/types';

/**
 * Post-deploy functional audit. For every report the normal user can see, apply
 * a filter matrix (OFAT + pairwise) through the real UI and record, per combo:
 *   - a combo-level roll-up (summary.csv)
 *   - a per-component state grid (components.csv): each component ok/empty/broken
 *   - a full-page screenshot, plus one per broken component
 * A report test FAILS only on ❌ broken; ⚪ empty is recorded, not failed.
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

test.beforeAll(() => {
  initSummary();
});

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
    await page.goto(reportUrl(report.id, {}), { waitUntil: 'domcontentloaded' });
    await waitForReportRender(page);
    const token = await waitForToken(page, getToken);
    test.skip(!token, 'No auth token captured — session may have expired; re-run `npm run prepare-run`.');

    const filters = await discoverFilters(page, token, report.id);
    const matrix = buildMatrix(filters);
    const brokenCombos: string[] = [];

    for (const combo of matrix) {
      const url = reportUrl(report.id, combo.params);
      capturedReport = null;
      capturedUrl = '';
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await waitForReportRender(page);
      await triggerLazyComponents(page); // render lazy charts/maps for the screenshot

      // Report-level DOM signals (what the user sees): timeout/error box, leaked {{}}.
      const dom = await classifyReport(page);

      // Per-component states from the report JSON the browser fetched (verified to
      // match this combo); else re-fetch with the token.
      const rep = capturedMatches(combo.params)
        ? capturedReport
        : await fetchReportJson(page, token, report.id, combo.params);
      const comps = rep ? componentStatesFromReport(rep) : [];
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
      const nErr = await errorCards.count().catch(() => 0);
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
      const row: ResultRow = {
        timestamp: ts,
        reportId: report.id,
        comboLabel: combo.label,
        varies: combo.varies,
        state,
        totalComponents: comps.length,
        okCount: okComps.length,
        emptyCount: emptyComps.length,
        brokenComponents: brokenTitles.join(' | '),
        leakedPlaceholders: dom.leakedPlaceholders,
        url,
        screenshot: fullShot,
      };
      appendResult(row);

      for (const comp of comps) {
        const crow: ComponentResultRow = {
          timestamp: ts,
          reportId: report.id,
          comboLabel: combo.label,
          varies: combo.varies,
          section: comp.section,
          component: comp.title,
          type: comp.type,
          state: comp.state,
          error: comp.error,
        };
        appendComponentResult(crow);
      }

      if (state === 'broken') {
        const detail = noData
          ? 'report fetch failed'
          : reportLevel && brokenComps.length === 0
            ? dom.neverRendered
              ? 'never rendered'
              : dom.leakedPlaceholders
                ? 'leaked {{placeholder}}'
                : dom.brokenComponents.filter((t) => t.startsWith('REPORT:')).join(', ')
            : `failed: ${brokenComps.map((c) => c.title).join(', ')}`;
        brokenCombos.push(`[${combo.label}] ${detail}`);
      }
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
 */
async function waitForReportRender(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const sc = document.querySelector('#sections-container');
        if (!sc) return false;
        if (sc.querySelector('.skeleton')) return false; // still loading
        const txt = (sc as HTMLElement).innerText || '';
        if (/No data available|No data found/i.test(txt)) return true; // empty, but done
        return sc.children.length > 0; // real content rendered
      },
      { timeout: config.renderTimeoutMs },
    )
    .catch(() => {});
  await page.waitForTimeout(400); // settle async transforms
}

/** Scroll through the page so lazy-loaded charts/maps actually render. */
async function triggerLazyComponents(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const step = Math.max(300, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y <= document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await sleep(150);
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(800); // let Chart.js/Leaflet finish
}
