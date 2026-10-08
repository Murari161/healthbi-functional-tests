import { chromium } from '@playwright/test';
import { config } from '../src/config';
import { attachTokenCapture, authHeader, waitForToken } from '../src/auth-capture';

/** One-off: find WHERE an unsubstituted {{placeholder}} lives in a report's JSON. */
async function main() {
  const reportId = 'Programs/Malaria/malaria-weekly-bulletin';
  const params: Record<string, string> = { region: 'Acholi' };

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ storageState: config.storageStatePath });
    const page = await ctx.newPage();
    const getToken = attachTokenCapture(page);
    await page.goto(`${config.baseUrl}/`, { waitUntil: 'domcontentloaded' });
    const token = await waitForToken(page, getToken, 30_000);
    if (!token) {
      console.log('No token — session expired. Run `npm run prepare-run` first.');
      return;
    }
    const qs = new URLSearchParams(params).toString();
    const res = await page.request.get(`${config.apiBase}/report/${encodeURIComponent(reportId)}?${qs}`, {
      headers: authHeader(token),
    });
    console.log('HTTP', res.status(), ' report=', reportId, ' params=', params);
    const rep: any = await res.json();

    let found = 0;
    const scan = (obj: any, path: string, comp: string) => {
      if (typeof obj === 'string') {
        const m = obj.match(/\{\{[^}]+\}\}/g);
        if (m) {
          console.log(`  LEAK  [${comp}] .${path} -> ${m.join(', ')}`);
          found++;
        }
      } else if (obj && typeof obj === 'object') {
        for (const k of Object.keys(obj)) scan(obj[k], path ? `${path}.${k}` : k, comp);
      }
    };
    for (const s of rep.sections ?? []) {
      for (const comp of s.components ?? []) scan(comp, '', comp.title || comp.type || '?');
    }
    console.log(found ? `\n${found} leak location(s) above.` : '\nNo {{…}} anywhere in the report JSON — the leak is produced client-side.');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
