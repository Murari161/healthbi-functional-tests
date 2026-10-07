import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, reportUrl } from '../src/config';
import { discoverFilters, buildMatrix } from '../src/filters';
import { classifyReport } from '../src/classify';
import { appendResult, initSummary, slug } from '../src/summary';
import type { ReportListItem, ResultRow } from '../src/types';

/**
 * Post-deploy functional audit: for every report the normal user can see, apply
 * the filter matrix through the real UI and record what loads / is empty / fails.
 *
 * A report test FAILS only on ❌ broken states (error cards, leaked placeholders,
 * never-rendered). ⚪ empty is recorded but NOT treated as a failure — it's a
 * real user-visible state, reported faithfully.
 */

// Load the cached report list produced by `npm run prepare-run`.
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
    const filters = await discoverFilters(page.request, report.id);
    const matrix = buildMatrix(filters);
    const brokenCombos: string[] = [];

    for (const combo of matrix) {
      const url = reportUrl(report.id, combo.params);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await waitForReportRender(page);
      await triggerLazyComponents(page); // charts/maps render on scroll

      const c = await classifyReport(page);

      const shot = join(config.resultsDir, 'screenshots', `${slug(report.id)}__${slug(combo.label)}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

      const row: ResultRow = {
        timestamp: new Date().toISOString(),
        reportId: report.id,
        comboLabel: combo.label,
        varies: combo.varies,
        state: c.state,
        totalComponents: c.totalComponents,
        okCount: c.okCount,
        emptyCount: c.emptyCount,
        brokenComponents: c.brokenComponents.join(' | '),
        leakedPlaceholders: c.leakedPlaceholders,
        url,
        screenshot: shot,
      };
      appendResult(row);

      if (c.state === 'broken') {
        const detail = c.neverRendered
          ? 'never rendered'
          : c.leakedPlaceholders
            ? 'leaked {{placeholder}}'
            : `failed: ${c.brokenComponents.join(', ')}`;
        brokenCombos.push(`[${combo.label}] ${detail}`);
      }
    }

    // Faithful gate: only ❌ broken fails the test; ⚪ empty is fine.
    expect(brokenCombos, `Broken under these filters:\n${brokenCombos.join('\n')}`).toEqual([]);
  });
}

/** Wait until the report shell + sections have settled (or empty state shown). */
async function waitForReportRender(page: Page): Promise<void> {
  // Loading overlay should clear.
  await page
    .locator('#loading-overlay')
    .waitFor({ state: 'hidden', timeout: 45_000 })
    .catch(() => {});
  // Either sections appear, or the report header shows (even an empty report).
  await Promise.race([
    page.locator('#sections-container .section').first().waitFor({ state: 'attached', timeout: 45_000 }),
    page.locator('#report-header').waitFor({ state: 'visible', timeout: 45_000 }),
  ]).catch(() => {});
  // Small settle for async transforms.
  await page.waitForTimeout(500);
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
