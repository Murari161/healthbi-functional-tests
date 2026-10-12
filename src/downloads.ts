import type { Download, Locator, Page } from '@playwright/test';
import { statSync } from 'node:fs';
import type { ComponentRow } from './components';
import {
  CSV_BTN,
  LAZY_TYPES,
  OWNER_COMPONENT,
  PNG_BTN,
  SECTIONS,
  VISUAL_FEEDBACK_BTN,
  type ControlsScan,
} from './controls-scan';
import { within } from './resilience';

/**
 * Download audit, per component, once per report (the wiring doesn't vary by
 * filter):
 *   - availability: does each component carry a download button? One without
 *     is reported 'missing', with the reason (amber in the grid).
 *   - function: every button found is clicked INSIDE its own component and
 *     must produce a real, non-empty file ('ok'), else 'failed'.
 * Read-only: files are inspected via Playwright's temp path, then discarded.
 */

export interface DownloadCheck {
  kind: 'csv' | 'png' | '';
  label: string;
  /** True only when a download was produced and non-empty (state 'ok'). */
  ok: boolean;
  filename: string;
  bytes: number;
  /** Failure message, or the reason a component is 'missing' / 'na'. */
  error: string;
  state: 'ok' | 'failed' | 'missing' | 'na';
  section: string;
  component: string;
  type: string;
  sectionIndex?: number;
  componentIndex?: number;
}

/** Types the app gives a download control (components.js renderTable + CHART_TYPES_WITH_DOWNLOAD). */
const TYPES_WITH_DOWNLOAD = new Set(['table', 'table_advanced', 'line', 'bar', 'pie', 'pyramid', 'bar_line', 'waterfall']);

const missingReason = (type: string) =>
  TYPES_WITH_DOWNLOAD.has(type)
    ? `no download button found (expected — ${type} components normally have one)`
    : `"${type || 'unknown'}" components never get a download button in the app`;

/** Click one download control and verify a real, non-empty file arrives. */
async function clickAndVerify(page: Page, btn: Locator): Promise<Pick<DownloadCheck, 'ok' | 'filename' | 'bytes' | 'error'>> {
  const r = { ok: false, filename: '', bytes: 0, error: '' };
  try {
    await btn.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    const waiting = page.waitForEvent('download', { timeout: 20_000 });
    waiting.catch(() => {}); // a click that throws must not leave this rejection unhandled
    await btn.click({ force: true, timeout: 5_000 }); // hover-revealed buttons stay clickable
    const dl: Download = await waiting;
    r.filename = dl.suggestedFilename();
    // failure() and path() wait for the transfer to finish — bound them.
    const failure = await within(dl.failure(), 30_000, 'download did not finish within 30s');
    if (failure) {
      r.error = failure;
    } else {
      const p = await within(dl.path(), 30_000, null);
      r.bytes = p ? statSync(p).size : 0;
      r.ok = r.bytes > 0;
      if (!r.ok) r.error = 'download completed but the file is empty';
    }
    await dl.delete().catch(() => {});
  } catch (e) {
    r.error = String(e).split('\n')[0].slice(0, 160) || 'no download started';
  }
  return r;
}

/**
 * Check every component's download availability and function. `comps` is the
 * report JSON's component list; `scan` maps on-screen controls to components.
 */
export async function checkDownloads(
  page: Page,
  comps: ComponentRow[],
  scan: ControlsScan,
  maxClicks = 60,
): Promise<DownloadCheck[]> {
  const out: DownloadCheck[] = [];
  const byKey = new Map(scan.components.map((m) => [`${m.sIdx}.${m.cIdx}`, m] as const));
  const nSections = scan.sectionButtonCount.length;
  let clicks = 0;

  for (const c of comps) {
    const base = { section: c.section, component: c.title, type: c.type, sectionIndex: c.sIdx, componentIndex: c.cIdx };
    const note = (state: 'missing' | 'na', reason: string) =>
      out.push({ ...base, kind: '', label: c.title, ok: false, filename: '', bytes: 0, error: reason, state });
    const m = byKey.get(`${c.sIdx}.${c.cIdx}`);

    if (nSections === 0) {
      note('na', 'report showed "No data available" — no components on screen to check');
    } else if (!m) {
      // No header controls were found for this component at all.
      if (c.state === 'broken') note('na', 'component failed to load — its error card has no download button');
      else if (LAZY_TYPES.has(c.type) && (scan.lazyLeft[c.sIdx] ?? 0) > 0)
        note('na', 'chart never rendered (lazy placeholder still showing) — could not check');
      else note('missing', missingReason(c.type));
    } else if (m.csv + m.png === 0) {
      note('missing', missingReason(c.type));
    } else {
      const block = page.locator(SECTIONS).nth(m.sIdx).locator(VISUAL_FEEDBACK_BTN).nth(m.k).locator(OWNER_COMPONENT);
      const kinds: Array<['csv' | 'png', number, string]> = [
        ['csv', m.csv, CSV_BTN],
        ['png', m.png, PNG_BTN],
      ];
      for (const [kind, n, sel] of kinds) {
        if (n === 0) continue;
        if (clicks >= maxClicks) {
          out.push({
            ...base,
            kind,
            label: c.title,
            ok: false,
            filename: '',
            bytes: 0,
            error: `button present — not clicked (download check capped at ${maxClicks} clicks per report)`,
            state: 'na',
          });
          continue;
        }
        clicks++;
        const r = await clickAndVerify(page, block.locator(sel).first());
        out.push({ ...base, kind, label: r.filename || c.title, ...r, state: r.ok ? 'ok' : 'failed' });
      }
    }
  }

  // Controls outside any component header (none in today's app): counted, not attributed.
  if (scan.orphanCsv + scan.orphanPng > 0) {
    out.push({
      kind: '',
      label: 'unattributed download controls',
      ok: false,
      filename: '',
      bytes: 0,
      error: `${scan.orphanCsv} CSV + ${scan.orphanPng} image download control(s) outside any component header — not checked`,
      state: 'na',
      section: '',
      component: '',
      type: '',
    });
  }

  const missing = out.filter((o) => o.state === 'missing').length;
  const failed = out.filter((o) => o.state === 'failed').length;
  console.log(
    `[downloads] ${comps.length} components: ${clicks} download(s) clicked, ${failed} failed · ${missing} component(s) without a download button`,
  );
  return out;
}
