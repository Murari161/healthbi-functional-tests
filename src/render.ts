import type { Page } from '@playwright/test';
import { config } from './config';
import { within } from './resilience';

/**
 * Wait until the report has finished loading: the app fills #sections-container
 * with `.skeleton` placeholders during its single /api/report fetch, then
 * replaces them with real sections (or a "No data" message). Timeout is generous
 * (config.renderTimeoutMs) to exceed the 30s per-component and 45s frontend limits.
 *
 * Skeletons inside `.chart-placeholder` don't count: those are lazy charts that
 * only render once scrolled into view (see triggerLazyComponents), not loading.
 * Returns when the report was seen finished (epoch ms), or 0 if it never was.
 */
export async function waitForReportRender(page: Page): Promise<number> {
  const shownAt = await page
    .waitForFunction(
      () => {
        if (document.querySelector('#kc-login, #kc-form-login')) return true; // sent to sign-in: stop waiting
        const sc = document.querySelector('#sections-container');
        if (!sc) return false;
        const loading = Array.from(sc.querySelectorAll('.skeleton')).some((el) => !el.closest('.chart-placeholder'));
        if (loading) return false;
        const txt = (sc as HTMLElement).innerText || '';
        if (/No data available|No data found/i.test(txt)) return true; // empty, but done
        return sc.children.length > 0; // real content rendered
      },
      undefined, // arg slot — options must be the THIRD parameter
      { timeout: config.renderTimeoutMs },
    )
    .then(() => Date.now())
    .catch(() => 0);
  await page.waitForTimeout(400); // settle async transforms
  return shownAt;
}

/**
 * Render every lazy chart, the way a user scrolling down does. The report
 * scrolls inside .report-container (overflow-y:auto), not the window, so each
 * `.chart-placeholder` is scrolled into view directly — that's what fires the
 * app's IntersectionObserver. Without this, below-the-fold charts stay
 * skeletons: no chart, no Feedback/PNG buttons, skeletons in screenshots.
 */
export async function triggerLazyComponents(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const left = await within(
      page
        .evaluate(async () => {
          const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
          const sel = '#sections-container .chart-placeholder';
          for (const el of Array.from(document.querySelectorAll(sel))) {
            el.scrollIntoView({ block: 'center' });
            await sleep(150);
          }
          return document.querySelectorAll(sel).length;
        })
        .catch(() => 0),
      20_000,
      -1, // page stopped answering — give up on lazy rendering for this combo
    );
    if (left <= 0) break;
  }
  await within(
    page
      .evaluate(() => {
        document.querySelector('.report-container')?.scrollTo(0, 0);
        window.scrollTo(0, 0);
      })
      .catch(() => {}),
    5_000,
    undefined,
  );
  await page.waitForTimeout(800); // let Chart.js/Leaflet finish
}
