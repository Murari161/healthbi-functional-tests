import type { Download, Page } from '@playwright/test';
import { statSync } from 'node:fs';

/** Result of exercising one per-component download control. */
export interface DownloadCheck {
  kind: 'csv' | 'png';
  label: string;
  ok: boolean;
  filename: string;
  bytes: number;
  error: string;
}

const CSV_BTN = '[data-tooltip="Download as CSV"]'; // table CSV export buttons
const PNG_BTN = '.component-download-btn'; // hover-revealed chart image buttons

/**
 * Click every per-component download control on the current page and verify a
 * real, non-empty download arrives. Run on the baseline combo only — the
 * download wiring doesn't vary by filter, and per-combo clicking would balloon
 * runtime. Files are inspected via Playwright's temp path and then discarded.
 */
export async function checkDownloads(page: Page, maxPerKind = 20): Promise<DownloadCheck[]> {
  const out: DownloadCheck[] = [];
  const kinds: Array<['csv' | 'png', string]> = [
    ['csv', CSV_BTN],
    ['png', PNG_BTN],
  ];
  for (const [kind, selector] of kinds) {
    const buttons = page.locator(`#sections-container ${selector}`);
    const n = Math.min(await buttons.count().catch(() => 0), maxPerKind);
    for (let i = 0; i < n; i++) {
      const btn = buttons.nth(i);
      const check: DownloadCheck = {
        kind,
        label: `${kind} control #${i + 1}`,
        ok: false,
        filename: '',
        bytes: 0,
        error: '',
      };
      try {
        await btn.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
        const waiting = page.waitForEvent('download', { timeout: 20_000 });
        await btn.click({ force: true, timeout: 5_000 }); // hover-revealed buttons stay clickable
        const dl: Download = await waiting;
        check.filename = dl.suggestedFilename();
        if (check.filename) check.label = check.filename;
        const failure = await dl.failure();
        if (failure) {
          check.error = failure;
        } else {
          const p = await dl.path();
          check.bytes = p ? statSync(p).size : 0;
          check.ok = check.bytes > 0;
          if (!check.ok) check.error = 'download completed but the file is empty';
        }
        await dl.delete().catch(() => {});
      } catch (e) {
        check.error = String(e).split('\n')[0].slice(0, 160) || 'no download started';
      }
      out.push(check);
    }
  }
  return out;
}
