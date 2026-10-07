import type { Page } from '@playwright/test';

/**
 * The Health BI API authenticates with a Keycloak Bearer token (not cookies):
 * the app sends `Authorization: Bearer <jwt>` on every /api call via authFetch,
 * refreshing the token in-page. A cookie-only request gets 401.
 *
 * Rather than reimplement the Keycloak refresh flow, we passively capture the
 * latest Bearer token from the app's own requests and reuse it for our API
 * reads. Every page navigation triggers app API calls, so the captured token
 * stays fresh across a long run.
 */
export function attachTokenCapture(page: Page): () => string | null {
  let token: string | null = null;
  page.on('request', (req) => {
    const auth = req.headers()['authorization'];
    if (auth && /^Bearer\s+/i.test(auth)) {
      token = auth.replace(/^Bearer\s+/i, '');
    }
  });
  return () => token;
}

/** Authorization header object for a captured token (empty if none yet). */
export function authHeader(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Wait until a Bearer token has been captured (app made an authed call). */
export async function waitForToken(
  page: Page,
  getToken: () => string | null,
  timeoutMs = 30_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (!getToken() && Date.now() < deadline) {
    await page.waitForTimeout(250);
  }
  return getToken();
}
