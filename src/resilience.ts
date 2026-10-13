import type { Page } from '@playwright/test';
import { config } from './config';

/**
 * Keep one stalled or unreachable page from freezing or misleading a run.
 *
 * Seen on prod 2026-10-12: (1) the request for a report page got no response;
 * page.goto failed after 45s and the test then hung 23 minutes on the
 * half-loaded page; (2) for 12 minutes the site was unreachable and the app's
 * service worker served its own "You are offline" page, which the audit then
 * judged as if it were the report ("broken: report fetch failed").
 */

/** The saved sign-in has expired: nothing after this can be judged, so the run stops. */
export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired: the app sent the browser to the sign-in page. Run `npm run prepare-run`, then re-run the tests.');
    this.name = 'SessionExpiredError';
  }
}

export interface PageLoad {
  ok: boolean;
  attempts: number;
  /** Why the report page wasn't usable ('' when ok). */
  error: string;
}

const LOGIN_FORM = '#kc-login, #kc-form-login';

/**
 * Open a report deep-link the way a user would and make sure what arrived IS
 * the report. Retried ONCE — what a user does by pressing refresh — when the
 * page doesn't arrive within `navTimeoutMs`, when the service worker serves
 * its "You are offline" page instead, or when the report comes back as the
 * app's in-page "You are offline" box. Between attempts the page is reset to
 * about:blank. An expired session throws SessionExpiredError.
 * `waitForRender` is the caller's wait for the report to finish loading.
 */
export async function loadReportPage(
  page: Page,
  url: string,
  opts: { navTimeoutMs: number; waitForRender: () => Promise<void>; onRetry?: (why: string) => void },
): Promise<PageLoad> {
  let error = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    error = await attemptLoad(page, url, opts);
    if (!error) return { ok: true, attempts: attempt, error: '' };
    await page.goto('about:blank', { timeout: 10_000 }).catch(() => {});
    if (attempt === 1) {
      opts.onRetry?.(error);
      await page.waitForTimeout(5_000);
    }
  }
  return { ok: false, attempts: 2, error };
}

/** One attempt: '' when the report page arrived and rendered, else why not. */
async function attemptLoad(
  page: Page,
  url: string,
  opts: { navTimeoutMs: number; waitForRender: () => Promise<void> },
): Promise<string> {
  let status = 0;
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.navTimeoutMs });
    status = resp?.status() ?? 0;
  } catch (e) {
    return String(e).split('\n')[0].slice(0, 200);
  }
  // What arrived: the report app's shell, its service-worker offline page, or the sign-in page?
  const landed = await page
    .waitForFunction(
      (loginSel) => {
        if (document.querySelector(loginSel)) return 'login';
        if (document.querySelector('#sections-container')) return 'app';
        const h = document.querySelector('h2');
        if (h && /you are offline/i.test(h.textContent || '')) return 'offline';
        return null;
      },
      LOGIN_FORM,
      { timeout: 30_000 },
    )
    .then((h) => h.jsonValue() as Promise<string>)
    .catch(() => 'unknown');
  if (landed === 'login') throw new SessionExpiredError();
  if (landed === 'offline') return `site unreachable: the app showed "You are offline"${status ? ` (HTTP ${status})` : ''}`;

  await opts.waitForRender();
  // keycloak-js redirects to sign-in only after the app shell has loaded.
  if (await isSignInPage(page)) throw new SessionExpiredError();
  const offlineBox = await within(page.locator('#sections-container .report-offline-state').count().catch(() => 0), 5_000, 0);
  if (offlineBox > 0) return 'site unreachable: the report showed "You are offline"';
  return '';
}

async function isSignInPage(page: Page): Promise<boolean> {
  let foreign = false;
  try {
    foreign = new URL(page.url()).origin !== new URL(config.baseUrl).origin;
  } catch {
    /* about:blank etc. */
  }
  if (!foreign) return false;
  return (await within(page.locator(LOGIN_FORM).count().catch(() => 0), 5_000, 0)) > 0;
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
