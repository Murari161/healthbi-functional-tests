import { test, expect } from '@playwright/test';
import { config, reportUrl } from '../src/config';
import { attachTokenCapture, waitForToken } from '../src/auth-capture';
import { discoverFilters } from '../src/filters';
import { waitForReportRender } from '../src/render';
import { allReports, loadReports } from '../src/reports';
import { loadReportPage } from '../src/resilience';
import { checkShare } from '../src/share';
import { appendPlatformResult } from '../src/summary';
import type { PlatformCheck } from '../src/types';

/**
 * Platform checks: features that are the same code on every report (the Share
 * menu), so they run ONCE per run — before the report checks (this file sorts
 * first) — on one report opened with EVERY filter set to one real value.
 * Results: platform.csv and the "Platform checks" table at the top of the
 * results page. Report: PLATFORM_REPORT, else the first report in scope.
 */

const targetId = config.platformReport || loadReports()[0]?.id || '';
const title = allReports().find((r) => r.id === targetId)?.title || targetId;

test('platform: share menu', async ({ page }) => {
  test.skip(!config.platformChecks, 'platform checks are off (PLATFORM_CHECKS=0)');
  test.skip(!targetId, 'no report in scope to run the platform checks on');
  test.setTimeout(8 * 60_000);

  const getToken = attachTokenCapture(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(config.baseUrl).origin });
  const load = { navTimeoutMs: config.navTimeoutMs, waitForRender: () => waitForReportRender(page) };

  // Prime: the app signs in (gives the token) and we learn the report's filters.
  const prime = await loadReportPage(page, reportUrl(targetId, {}), load);
  expect(prime.ok, `Report page never loaded (2 attempts): ${prime.error}`).toBe(true);
  const token = await waitForToken(page, getToken);
  test.skip(!token, 'No auth token captured — session may have expired; re-run `npm run prepare-run`.');

  // Every filter set to one real value from the app's own dropdown lists (cascades kept).
  const filters = await discoverFilters(page, token, targetId);
  const selected = Object.fromEntries(
    filters.filter((f) => f.values.length > 0).map((f) => [f.def.paramName, f.values[0]] as [string, string]),
  );
  const setup = `${title} with ${Object.entries(selected).map(([k, v]) => `${k}=${v}`).join(', ') || 'no filters (it has none)'}`;
  console.log(`▶ platform checks on ${setup}`);

  const nav = await loadReportPage(page, reportUrl(targetId, selected), load);
  const rows: PlatformCheck[] = nav.ok
    ? await checkShare(page, { title, selected })
    : [{ area: 'Share', check: 'Open the report with every filter set', found: `the page never loaded: ${nav.error}`, status: 'fail' }];

  for (const r of rows) {
    appendPlatformResult({ timestamp: new Date().toISOString(), reportId: targetId, setup, ...r });
    console.log(`[platform] ${r.status === 'pass' ? '✓' : r.status === 'warn' ? '⚠' : '✗'} ${r.area} · ${r.check} — ${r.found}`);
  }
  const failed = rows.filter((r) => r.status === 'fail').map((r) => `${r.area} · ${r.check}: ${r.found}`);
  expect(failed, `Platform checks failed:\n${failed.join('\n')}`).toEqual([]);
});
