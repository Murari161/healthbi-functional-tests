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
    screenshot: 'on',
    trace: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
