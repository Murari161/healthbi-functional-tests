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
 * Render every lazy chart, the way a user scrolling down does. Charts and maps
 * are `.chart-placeholder` skeletons until the app sees them come into view.
 * The report scrolls inside .report-container, so we scroll it with the mouse
 * wheel, about a screenful at a time with a short pause, all the way down —
 * like a person reading. (Jumping each placeholder into view with
 * scrollIntoView did not wake the app's chart loader on some reports: on WASH
 * every chart stayed a skeleton.) Anything still not drawn then gets the
 * jump-into-view pass as a fallback.
 */
export async function triggerLazyComponents(page: Page): Promise<void> {
  const placeholdersLeft = () =>
    within(page.locator('#sections-container .chart-placeholder').count().catch(() => 0), 5_000, 0);
  if ((await placeholdersLeft()) > 0) await wheelThroughReport(page);
  const deadline = Date.now() + ((await placeholdersLeft()) > 0 ? 15_000 : 0);
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

/** Mouse-wheel down the report a screenful at a time until it stops moving (the bottom), max 30 s. */
async function wheelThroughReport(page: Page): Promise<void> {
  const at = await within(
    page
      .evaluate(() => {
        const r = document.querySelector('#sections-container')?.getBoundingClientRect();
        if (!r) return null;
        const top = Math.max(r.top, 0);
        const bottom = Math.min(r.bottom, window.innerHeight);
        return { x: r.left + r.width / 2, y: bottom > top ? (top + bottom) / 2 : window.innerHeight / 2 };
      })
      .catch(() => null),
    5_000,
    null,
  );
  if (!at) return;
  const scrolled = () =>
    within(
      page.evaluate(() => document.querySelector('.report-container')?.scrollTop ?? window.scrollY).catch(() => -1),
      5_000,
      -1,
    );
  await page.mouse.move(at.x, at.y);
  const deadline = Date.now() + 30_000;
  let last = await scrolled();
  while (Date.now() < deadline) {
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(250);
    const now = await scrolled();
    if (now === last) break; // the bottom (or the page stopped scrolling)
    last = now;
  }
  await page.waitForTimeout(800); // let the last charts draw
  await page.mouse.move(1, 1); // off the report: no hover tooltip left in screenshots
}

/**
 * Screenshot the whole report. It scrolls inside .report-container, so a plain
 * element screenshot only paints what is on screen (everything below came out
 * blank). For the picture, the window is made tall enough to show the whole
 * report (capped at 16,000 px), then put back.
 */
export async function screenshotReport(page: Page, path: string, extra?: () => Promise<void>): Promise<void> {
  const vp = page.viewportSize();
  const hidden = await within(
    page
      .evaluate(() => {
        const c = document.querySelector('.report-container');
        return c ? c.scrollHeight - c.clientHeight : 0;
      })
      .catch(() => 0),
    5_000,
    0,
  );
  try {
    if (vp && hidden > 0) {
      await page.setViewportSize({ width: vp.width, height: Math.min(vp.height + hidden, 16_000) });
      await page.waitForTimeout(600); // let charts and maps re-fit the taller window
    }
    await page
      .locator('#sections-container')
      .screenshot({ path, timeout: 30_000 })
      .catch(async () => {
        await page.screenshot({ path, fullPage: true }).catch(() => {});
      });
    if (extra) await extra(); // more pictures while the whole report is on screen
  } finally {
    if (vp && hidden > 0) await page.setViewportSize(vp).catch(() => {});
  }
}
