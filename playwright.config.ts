import { defineConfig, devices } from '@playwright/test';
import { config } from './src/config';

/**
 * Post-deploy functional audit of Health BI reports against the LIVE site.
 *
 * - Runs serially (1 worker) to stay gentle on production.
 * - Reuses the authenticated session saved by `npm run prepare-run`.
 * - Captures a screenshot per report so results can be eyeballed.
 * - No `webServer`: we drive the deployed site, not a local server.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './src/global-setup.ts',
  globalTeardown: './src/html-report.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 5 * 60 * 1000, // a report runs many filter combos
  expect: { timeout: 15_000 },
  use: {
    baseURL: config.baseUrl,
    storageState: config.storageStatePath,
    // Off: the spec saves its own screenshot per combo. Playwright's automatic
    // end-of-test screenshot hung for 23 min on a half-loaded page (2026-10-12).
    screenshot: 'off',
    trace: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: config.navTimeoutMs,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
