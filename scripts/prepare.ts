import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../src/config';
import { attachTokenCapture, authHeader, waitForToken } from '../src/auth-capture';
import type { ReportListItem } from '../src/types';

/**
 * One-time prep, run before the suite (`npm run prepare-run`, or via `npm run qa`):
 *   1. Logs in through Keycloak as a NORMAL user and saves the session.
 *   2. Enumerates the reports that user can see and caches the list.
 *
 * A saved session is first checked in a hidden browser: if it still works it is
 * reused and no window opens. Only when it is missing or expired does a window
 * open — a fresh one, with no stale cookies — so the sign-in page shows once.
 * (Checking in the visible window and then reloading it to clear the old
 * cookies made the sign-in page appear twice.)
 *
 * Two ways to log in:
 *   - MANUAL (recommended): leave HEALTHBI_USER/PASS unset and just sign in by
 *     hand in the window that opens (also handles MFA). Nothing is stored.
 *   - AUTOMATED: set HEALTHBI_USER/PASS in .env and the form is filled for you.
 * Credentials, when provided, are only ever typed into the Keycloak page and are
 * never logged or stored in results.
 */

const LOGIN_TIMEOUT = 5 * 60 * 1000; // allow time for manual login / MFA
const appUrl = `${config.baseUrl}/`; // trailing slash: nginx serves the app at /report-browser/

async function main() {
  mkdirSync(dirname(config.storageStatePath), { recursive: true });
  mkdirSync(dirname(config.reportsCachePath), { recursive: true });

  if (existsSync(config.storageStatePath)) {
    if (await reuseSavedSession()) return;
    console.log('→ Saved session expired — opening a sign-in window…');
  }
  await signIn();
}

/** Check the saved session without opening a window; if it works, refresh it and the report list. */
async function reuseSavedSession(): Promise<boolean> {
  console.log('→ Checking the saved session…');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: config.storageStatePath });
    const page = await context.newPage();
    const getToken = attachTokenCapture(page);
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    // A token means the app is signed in; the sign-in form means the session expired.
    const token = await Promise.race([
      waitForToken(page, getToken, 8_000),
      page
        .waitForSelector('#kc-login, #kc-form-login', { timeout: 8_000 })
        .then(() => null)
        .catch(() => null),
    ]);
    if (!token) return false;
    console.log('✓ Reused existing session (no login needed).');
    await page.waitForSelector('#aimara-tree-container', { timeout: 30_000 }).catch(() => {});
    await saveSessionAndReports(context, page, token);
    return true;
  } finally {
    await browser.close();
  }
}

/** Open a fresh window (no stale cookies) and wait for the user to sign in, or fill the form from .env. */
async function signIn(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const getToken = attachTokenCapture(page);
    console.log(`→ Opening ${appUrl} …`);
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });

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

    // The API wants a Keycloak Bearer token (not cookies): reuse the one the app sends on its own calls.
    console.log('→ Capturing auth token…');
    const token = await waitForToken(page, getToken);
    if (!token) throw new Error('No Bearer token captured — is the session still valid? Try logging in again.');
    await saveSessionAndReports(context, page, token);
  } finally {
    await browser.close();
  }
}

/** Save the signed-in session and cache the reports this user can see (same endpoint the UI uses). */
async function saveSessionAndReports(context: BrowserContext, page: Page, token: string): Promise<void> {
  await context.storageState({ path: config.storageStatePath });
  console.log(`✓ Saved authenticated session → ${config.storageStatePath}`);

  console.log('→ Fetching report list…');
  const res = await page.request.get(`${config.apiBase}/reports`, { headers: authHeader(token) });
  if (!res.ok()) throw new Error(`GET /reports failed: HTTP ${res.status()}`);
  const body = await res.json();
  const reports: ReportListItem[] = Array.isArray(body) ? body : (body.reports ?? []);
  if (reports.length === 0) throw new Error('No reports returned — check HEALTHBI_API_BASE.');

  writeFileSync(config.reportsCachePath, JSON.stringify(reports, null, 2), 'utf8');
  console.log(`✓ Cached ${reports.length} reports → ${config.reportsCachePath}`);
}

main().catch((err) => {
  console.error('prepare failed:', err);
  process.exit(1);
});
