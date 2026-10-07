import { chromium } from '@playwright/test';
import { config } from '../src/config';
import { attachTokenCapture, authHeader, waitForToken } from '../src/auth-capture';

/**
 * Quick auth/API check. Reuses the saved session (.auth/user.json), opens the
 * app so the Keycloak adapter mints a Bearer token, captures it, and calls
 * /reports with it. Run AFTER `npm run prepare-run`:
 *   npm run probe
 * Expected: "200 ... → N reports ✅". If it says the session expired, re-run
 * `npm run prepare-run` to log in again.
 */
async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: config.storageStatePath });
  const page = await context.newPage();
  const getToken = attachTokenCapture(page);

  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#aimara-tree-container', { timeout: 60_000 }).catch(() => {});
  const token = await waitForToken(page, getToken, 30_000);

  if (!token) {
    console.log('✗ No Bearer token captured — the saved session is likely expired.');
    console.log('  Re-run `npm run prepare-run` to log in again.');
  } else {
    const r = await page.request.get(`${config.apiBase}/reports`, { headers: authHeader(token) });
    const ct = (r.headers()['content-type'] || '').split(';')[0];
    let note = '';
    if (r.ok() && ct.includes('json')) {
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j.reports ?? []);
      note = `→ ${arr.length} reports ✅`;
    }
    console.log(`${r.status()} ${ct}  ${config.apiBase}/reports  ${note}`);
  }

  await browser.close();
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
