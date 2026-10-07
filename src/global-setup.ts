import { chromium, type FullConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { config } from './config';
import { attachTokenCapture, waitForToken } from './auth-capture';

/**
 * Runs once before the whole suite. Verifies the saved session is still valid
 * (the app mints an auth token) so an EXPIRED session fails the run fast with a
 * clear message — instead of every report waiting the full render timeout and
 * skipping. Run `npm run prepare-run` to refresh the session.
 */
export default async function globalSetup(_config: FullConfig): Promise<void> {
  if (!existsSync(config.storageStatePath)) {
    throw new Error(
      `No saved session at ${config.storageStatePath}. Run \`npm run prepare-run\` first.`,
    );
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: config.storageStatePath });
    const page = await context.newPage();
    const getToken = attachTokenCapture(page);
    await page.goto(`${config.baseUrl}/`, { waitUntil: 'domcontentloaded' });
    const token = await waitForToken(page, getToken, 25_000);
    if (!token) {
      throw new Error(
        'Saved session appears expired (no auth token captured). ' +
          'Re-run `npm run prepare-run` to log in again, then re-run the audit.',
      );
    }
    console.log('✓ Session valid — auth token captured. Starting audit.');
  } finally {
    await browser.close();
  }
}
