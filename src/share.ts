import type { Dialog, Download, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { config } from './config';
import { waitForReportRender } from './render';
import { loadReportPage, within } from './resilience';
import type { PlatformCheck } from './types';

/**
 * Platform check: the report Share menu (#share-btn → #share-menu). It is the
 * same code on every report, so it runs once per run, on a report opened with
 * EVERY filter set — the shared link and messages must then carry all of them.
 *
 * Read-only: Email and WhatsApp are captured, never opened (window.open is
 * replaced by a recorder while they are clicked); Save Offline only touches
 * this throwaway browser and is undone at once; the PDF is built by the server
 * like any user's download, inspected, then deleted; Copy Link uses the real
 * clipboard (permission granted to the test browser).
 */

const EXPECTED = ['Download PDF', 'Save Offline', 'Copy Link', 'Email', 'WhatsApp'];
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

async function openMenu(page: Page): Promise<void> {
  if ((await page.locator('#share-menu.active').count()) === 0) await page.locator('#share-btn').click({ timeout: 5_000 });
  await page.locator('#share-menu.active').waitFor({ timeout: 5_000 });
}

async function closeMenu(page: Page): Promise<void> {
  if ((await page.locator('#share-menu.active').count()) > 0)
    await page.locator('#share-btn').click({ timeout: 5_000 }).catch(() => {});
}

const menuItem = (page: Page, label: string) => page.locator('#share-menu .share-menu-item', { hasText: label });

/** The selected filters that a URL does NOT carry with the same value. */
function missingFilters(url: string, selected: Record<string, string>): string[] {
  let q: URLSearchParams | null = null;
  try {
    q = new URL(url).searchParams;
  } catch {
    /* not a URL */
  }
  return Object.entries(selected)
    .filter(([k, v]) => q?.get(k) !== v)
    .map(([k]) => k);
}

const firstLink = (text: string) => text.match(/https?:\/\/\S+/)?.[0] ?? '';

export async function checkShare(
  page: Page,
  opts: { title: string; selected: Record<string, string> },
): Promise<PlatformCheck[]> {
  const out: PlatformCheck[] = [];
  const add = (check: string, status: PlatformCheck['status'], found: string) =>
    out.push({ area: 'Share', check, found, status });
  const all = Object.entries(opts.selected)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const dialogs: string[] = [];
  const onDialog = (d: Dialog) => {
    dialogs.push(d.message());
    d.dismiss().catch(() => {});
  };
  const said = () => (dialogs.length ? ` (the app said: "${dialogs[dialogs.length - 1].slice(0, 120)}")` : '');
  page.on('dialog', onDialog);
  try {
    // 1. The button and its menu.
    if (!(await page.locator('#share-btn').isVisible().catch(() => false))) {
      add('Share button and menu', 'fail', 'no Share button in the report header');
      return out;
    }
    await openMenu(page);
    const items = (await page.locator('#share-menu .share-menu-item').allInnerTexts()).map(clean);
    const absent = EXPECTED.filter((e) => !items.some((t) => t.includes(e)));
    add(
      'Share button and menu',
      absent.length ? 'fail' : 'pass',
      absent.length
        ? `the menu is missing ${absent.join(', ')} (it has: ${items.join(' · ')})`
        : `the menu opens with ${EXPECTED.join(', ')}`,
    );
    await closeMenu(page);

    // 2–3. Email and WhatsApp: record what would open; nothing is opened or sent.
    await page.evaluate(() => {
      const w = window as any;
      w.__qaOpened = [];
      w.__qaOpen = window.open;
      window.open = ((u?: string | URL) => {
        w.__qaOpened.push(String(u));
        return null;
      }) as typeof window.open;
    });
    try {
      if (absent.includes('Email')) {
        add('Email', 'fail', 'no Email option in the menu');
      } else {
        await openMenu(page);
        await menuItem(page, 'Email').click({ timeout: 5_000 });
        await page.waitForTimeout(1_000); // the app falls back to Gmail after 500 ms
        const opened: string[] = await page.evaluate(() => (window as any).__qaOpened.splice(0));
        const mailto = opened.find((u) => u.startsWith('mailto:'));
        const gmail = opened.find((u) => u.startsWith('https://mail.google.com/'));
        if (!mailto) {
          add('Email', 'fail', `no email was opened${said()}`);
        } else {
          const q = new URLSearchParams(mailto.slice(mailto.indexOf('?') + 1));
          const subject = q.get('subject') ?? '';
          const link = firstLink(q.get('body') ?? '');
          const lost = link ? missingFilters(link, opts.selected) : [];
          const titled = subject.includes(opts.title);
          add(
            'Email',
            titled && link && lost.length === 0 ? 'pass' : 'fail',
            `subject "${subject}"; ${
              !link ? 'the message has no link' : lost.length ? `the link is missing ${lost.join(', ')}` : 'the message links to this view with every filter'
            }${titled ? '' : '; the subject lacks the report title'}${gmail ? '; Gmail fallback ready (no mail app here)' : ''}`,
          );
        }
      }

      if (absent.includes('WhatsApp')) {
        add('WhatsApp', 'fail', 'no WhatsApp option in the menu');
      } else {
        await openMenu(page);
        await menuItem(page, 'WhatsApp').click({ timeout: 5_000 });
        await page.waitForTimeout(500);
        const opened: string[] = await page.evaluate(() => (window as any).__qaOpened.splice(0));
        const wa = opened.find((u) => u.startsWith('https://wa.me/'));
        if (!wa) {
          add('WhatsApp', 'fail', `WhatsApp was not opened${said()}`);
        } else {
          const text = new URL(wa).searchParams.get('text') ?? '';
          const link = firstLink(text);
          const lost = link ? missingFilters(link, opts.selected) : [];
          const titled = text.includes(opts.title);
          add(
            'WhatsApp',
            titled && link && lost.length === 0 ? 'pass' : 'fail',
            `message "${clean(text.replace(link, '').trim())}" + ${
              !link ? 'no link' : lost.length ? `a link missing ${lost.join(', ')}` : 'a link to this view with every filter'
            }${titled ? '' : '; the message lacks the report title'}`,
          );
        }
      }
    } finally {
      await page
        .evaluate(() => {
          const w = window as any;
          if (w.__qaOpen) window.open = w.__qaOpen;
        })
        .catch(() => {});
    }

    // 4. Save Offline — stored in this throwaway browser only, and undone at once.
    if (absent.includes('Save Offline')) {
      add('Save Offline', 'fail', 'no Save Offline option in the menu');
    } else {
      const label = () => page.locator('#save-offline-label').innerText().catch(() => '');
      await openMenu(page);
      await page.locator('#save-offline-btn').click({ timeout: 5_000 });
      const saved = await page
        .waitForFunction(() => /Remove Offline Copy/i.test(document.querySelector('#save-offline-label')?.textContent || ''), undefined, { timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      let undone = false;
      if (saved) {
        await openMenu(page);
        await page.locator('#save-offline-btn').click({ timeout: 5_000 });
        undone = await page
          .waitForFunction(() => /^\s*Save Offline\s*$/i.test(document.querySelector('#save-offline-label')?.textContent || ''), undefined, { timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
      }
      await closeMenu(page);
      add(
        'Save Offline',
        saved && undone ? 'pass' : 'fail',
        saved
          ? `saved — the option became "Remove Offline Copy"${undone ? '; removing it again worked' : `; removing it again did not (it says "${clean(await label())}")`}`
          : `the option never became "Remove Offline Copy" (it says "${clean(await label())}")${said()}`,
      );
    }

    // 5. Download PDF — built by the server, inspected locally, then deleted.
    if (absent.includes('Download PDF')) {
      add('Download PDF', 'fail', 'no Download PDF option in the menu');
    } else {
      await openMenu(page);
      const t0 = Date.now();
      const waiting = page.waitForEvent('download', { timeout: 120_000 });
      waiting.catch(() => {});
      let dl: Download | null = null;
      try {
        await page.locator('#download-pdf-btn').click({ timeout: 5_000 });
        dl = await waiting;
      } catch {
        dl = null;
      }
      if (!dl) {
        add('Download PDF', 'fail', `no PDF arrived within 2 minutes${said()}`);
      } else {
        const p = await within(dl.path(), 60_000, null);
        const buf = p ? readFileSync(p) : Buffer.alloc(0);
        const isPdf = buf.subarray(0, 4).toString('latin1') === '%PDF';
        add(
          'Download PDF',
          buf.length > 0 && isPdf ? 'pass' : 'fail',
          `${dl.suggestedFilename()} · ${Math.round(buf.length / 1024)} KB · built in ${((Date.now() - t0) / 1000).toFixed(1)} s${isPdf ? '' : ' — but the file is not a PDF'}`,
        );
        await dl.delete().catch(() => {});
      }
    }

    // 6–7. Copy Link — the real clipboard; then whether the button survives it.
    let copied = '';
    if (absent.includes('Copy Link')) {
      add('Copy Link', 'fail', 'no Copy Link option in the menu');
    } else {
      await openMenu(page);
      await menuItem(page, 'Copy Link').click({ timeout: 5_000 });
      const confirmed = await page
        .waitForFunction(() => /Copied/i.test(document.querySelector('#share-btn')?.textContent || ''), undefined, { timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
      copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
      const lost = copied ? missingFilters(copied, opts.selected) : [];
      add(
        'Copy Link',
        copied && lost.length === 0 ? 'pass' : 'fail',
        !copied
          ? `nothing was copied${said()}`
          : lost.length
            ? `the copied link is missing ${lost.join(', ')}: ${copied}`
            : `copied this view's link with every filter (${all})${confirmed ? '; "Copied!" was shown' : '; no "Copied!" confirmation appeared'}`,
      );
      await page.waitForTimeout(2_000); // the app resets the button 1.5 s after "Copied!"
      const icon = await page.locator('#share-btn svg').count().catch(() => 0);
      add(
        'Share button after Copy Link',
        icon > 0 ? 'pass' : 'fail',
        icon > 0
          ? 'the Share button kept its icon'
          : 'after "Copied!" the Share button was left blank — its icon is gone until the page is reloaded',
      );
    }

    // 8. The copied link, opened in a new tab as a recipient would.
    if (copied) {
      const tab = await page.context().newPage();
      let dataUrl = '';
      tab.on('response', async (resp) => {
        try {
          if (resp.request().method() !== 'GET' || !resp.url().includes('/api/report/') || !resp.ok()) return;
          const j = await resp.json();
          if (j && Array.isArray(j.sections)) dataUrl = resp.url();
        } catch {
          /* not the report payload */
        }
      });
      try {
        const nav = await loadReportPage(tab, copied, {
          navTimeoutMs: config.navTimeoutMs,
          waitForRender: () => waitForReportRender(tab),
        });
        const sections = await tab.locator('#sections-container > .section').count().catch(() => 0);
        const lost = dataUrl ? missingFilters(dataUrl, opts.selected) : Object.keys(opts.selected);
        add(
          'Shared link opens the same view',
          nav.ok && sections > 0 && lost.length === 0 ? 'pass' : 'fail',
          !nav.ok
            ? `the copied link did not open: ${nav.error}`
            : sections === 0
              ? 'the copied link opened, but no report appeared'
              : lost.length
                ? `the report opened, but its data request dropped ${lost.join(', ')}`
                : `opened in a new tab: the same report with the same filters (${all})`,
        );
      } finally {
        await tab.close().catch(() => {});
      }
    }
  } finally {
    page.off('dialog', onDialog);
  }
  return out;
}
