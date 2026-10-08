import { chromium, type FullConfig } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
    // Establish this run's own output folder (results/<run-id>) so a new run
    // never clobbers files you still have open (e.g. summary.csv in Excel).
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    process.env.AUDIT_RUN_ID = runId; // inherited by test workers + teardown
    mkdirSync(config.resultsDir, { recursive: true });
    writeFileSync(join(config.resultsDir, '.run-id'), runId, 'utf8');
    mkdirSync(join(config.resultsDir, runId), { recursive: true });
    console.log(`✓ Session valid. Output → ${join(config.resultsDir, runId)}`);
  } finally {
    await browser.close();
  }
}
