import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../src/config';
import type { ReportListItem } from '../src/types';

/**
 * One-time prep, run before the suite (`npm run prepare-run`, or via `npm run qa`):
 *   1. Logs in through Keycloak as a NORMAL user and saves the session.
 *   2. Enumerates the reports that user can see and caches the list.
 *
 * The browser opens HEADED so you can watch — and, if the automated form fill
 * doesn't match your Keycloak theme (or there's MFA), you can simply log in by
 * hand in that window; the script waits for you to land back in the app.
 *
 * Credentials come from .env (HEALTHBI_USER / HEALTHBI_PASS) and are only ever
 * typed into the Keycloak page. They are never logged or stored in results.
 */

const LOGIN_TIMEOUT = 4 * 60 * 1000; // allow time for manual login / MFA

async function main() {
  config.requireCreds();
  mkdirSync(dirname(config.storageStatePath), { recursive: true });
  mkdirSync(dirname(config.reportsCachePath), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`→ Opening ${config.baseUrl} …`);
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });

  // Attempt automated Keycloak login. These are the Keycloak default selectors;
  // if your theme differs, the catch path lets you log in manually instead.
  // TODO (live-validate): confirm #username / #password / #kc-login on the
  // actual Health BI Keycloak page.
  try {
    const userField = page.locator('#username');
    await userField.waitFor({ state: 'visible', timeout: 15_000 });
    console.log('→ Keycloak login form detected — filling credentials…');
    await userField.fill(config.user);
    await page.locator('#password').fill(config.pass);
    await page.locator('#kc-login, button[type="submit"], input[type="submit"]').first().click();
  } catch {
    console.log('→ Automated login form not found. If a login page is open, please');
    console.log('  log in manually in the browser window. Waiting…');
  }

  // Wait until we're back in the app with the report tree present.
  console.log('→ Waiting for the app to load (report tree)…');
  await page.waitForURL((url) => url.href.startsWith(config.baseUrl), { timeout: LOGIN_TIMEOUT });
  await page.waitForSelector('#aimara-tree-container', { timeout: LOGIN_TIMEOUT });

  await context.storageState({ path: config.storageStatePath });
  console.log(`✓ Saved authenticated session → ${config.storageStatePath}`);

  // Enumerate reports via the same endpoint the UI uses (authenticated).
  console.log('→ Fetching report list…');
  const res = await page.request.get(`${config.apiBase}/reports`);
  if (!res.ok()) throw new Error(`GET /reports failed: HTTP ${res.status()}`);
  const body = await res.json();
  const reports: ReportListItem[] = Array.isArray(body) ? body : (body.reports ?? []);
  if (reports.length === 0) throw new Error('No reports returned — check HEALTHBI_API_BASE.');

  writeFileSync(config.reportsCachePath, JSON.stringify(reports, null, 2), 'utf8');
  console.log(`✓ Cached ${reports.length} reports → ${config.reportsCachePath}`);

  await browser.close();
}

main().catch((err) => {
  console.error('prepare failed:', err);
  process.exit(1);
});
