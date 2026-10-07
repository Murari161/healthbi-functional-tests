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
 * Two ways to log in:
 *   - MANUAL (recommended): leave HEALTHBI_USER/PASS unset and just sign in by
 *     hand in the window that opens (also handles MFA). Nothing is stored.
 *   - AUTOMATED: set HEALTHBI_USER/PASS in .env and the form is filled for you.
 * Credentials, when provided, are only ever typed into the Keycloak page and are
 * never logged or stored in results.
 */

const LOGIN_TIMEOUT = 5 * 60 * 1000; // allow time for manual login / MFA

async function main() {
  mkdirSync(dirname(config.storageStatePath), { recursive: true });
  mkdirSync(dirname(config.reportsCachePath), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`→ Opening ${config.baseUrl} …`);
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });

  // Login. Selectors confirmed on the live Health BI Keycloak page
  // (realm MoH): #username / #password / #kc-login.
  const haveCreds = !!(config.user && config.pass);
  if (haveCreds) {
    try {
      const userField = page.locator('#username');
      await userField.waitFor({ state: 'visible', timeout: 15_000 });
      console.log('→ Login form detected — filling credentials from .env…');
      await userField.fill(config.user);
      await page.locator('#password').fill(config.pass);
      await page.locator('#kc-login, button[type="submit"], input[type="submit"]').first().click();
    } catch {
      console.log('→ Could not auto-fill the form. Please log in manually in the');
      console.log('  browser window that just opened. Waiting…');
    }
  } else {
    console.log('→ No credentials in .env — please LOG IN MANUALLY in the browser');
    console.log('  window that just opened (MFA is fine; you have a few minutes). Waiting…');
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
