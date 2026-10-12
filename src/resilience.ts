import type { Page } from '@playwright/test';

/**
 * Keep one stalled step from freezing a whole run.
 *
 * Seen on prod 2026-10-12: the request for a report page got no response at
 * all; page.goto failed after 45s and the test then hung for 23 minutes on a
 * half-loaded page. These helpers bound the steps that could wait forever.
 */

/**
 * Open a report deep-link, retrying ONCE if the page doesn't arrive in time —
 * what a user does by pressing refresh. Between attempts the stuck navigation
 * is abandoned (about:blank), so the retry — or whatever runs next — starts on
 * a clean page. Never throws.
 */
export async function gotoWithRetry(
  page: Page,
  url: string,
  timeoutMs: number,
  onRetry?: (error: string) => void,
): Promise<{ ok: boolean; attempts: number; error: string }> {
  let error = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      return { ok: true, attempts: attempt, error: '' };
    } catch (e) {
      error = String(e).split('\n')[0].slice(0, 200);
      await page.goto('about:blank', { timeout: 10_000 }).catch(() => {});
      if (attempt === 1) {
        onRetry?.(error);
        await page.waitForTimeout(2_000);
      }
    }
  }
  return { ok: false, attempts: 2, error };
}

/**
 * Resolve to `onTimeout` if `p` hasn't settled within `ms`. For ONE-SHOT page
 * reads only (page.evaluate has no timeout of its own, so a stalled page main
 * thread would otherwise wait forever) — never for multi-step flows, which
 * would keep acting on the page after being abandoned. Rejections pass through.
 */
export function within<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
