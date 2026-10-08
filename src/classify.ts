import type { Page } from '@playwright/test';
import type { ReportClassification } from './types';

/**
 * Reads the RENDERED DOM to decide what a normal user actually sees for the
 * current report. This is pure UI observation — no backend/DB access.
 *
 * Classification (worst-of across the page):
 *   broken  - an error card ("Failed to load data"), leaked {{placeholder}}
 *             text, or the report shell never rendered.
 *   empty   - rendered, but nothing with data (no chart/table-rows/KPI value).
 *             This is a real, honest user-visible state — NOT a failure.
 *   ok      - at least one component rendered with data.
 *
 * Selectors come from public/index.html + components.js:
 *   #sections-container .section          -> rendered sections
 *   .component-error .component-error-title -> a failed component + its title
 *   #report-header                        -> the report shell
 */
export async function classifyReport(page: Page): Promise<ReportClassification> {
  return page.evaluate(() => {
    const root = document.querySelector('#sections-container');
    const header = document.querySelector('#report-header') as HTMLElement | null;
    const sections = root ? root.querySelectorAll('.section') : [];

    const headerVisible = !!header && header.offsetParent !== null;
    const neverRendered = !root || (sections.length === 0 && !headerVisible);

    // Failed components (the ❌ signal the QA analyst hunts for).
    const errorCards = root ? Array.from(root.querySelectorAll('.component-error')) : [];
    const brokenComponents = errorCards.map((el) => {
      const t = el.querySelector('.component-error-title');
      return (t?.textContent || 'Untitled component').trim();
    });

    // Report-level failure: the whole fetch errored or hit the 45s frontend hard
    // timeout, replacing all content with a retry/offline box (not per-component
    // cards). Flag it as broken, not empty.
    const reportErrEl = root
      ? root.querySelector('.report-error-state') || root.querySelector('.report-offline-state')
      : null;
    if (reportErrEl) {
      const msg = ((reportErrEl as HTMLElement).innerText || 'report-level error')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
      brokenComponents.unshift(`REPORT: ${msg}`);
    }

    // Leaked, unsubstituted placeholders indicate a filter/alias bug. Capture the
    // actual {{alias}} strings (attributed to a KPI card title where possible) so
    // the report can say WHICH placeholder leaked, not just that one did.
    const leakedSamples: string[] = [];
    if (root) {
      const seen = new Set<string>();
      root.querySelectorAll('.kpi-card').forEach((card) => {
        const t = (card as HTMLElement).innerText || '';
        const m = t.match(/\{\{[^}]+\}\}/g);
        if (m) {
          const title = card.querySelector('.kpi-card__title')?.textContent?.trim() || 'KPI';
          leakedSamples.push(`${title}: ${Array.from(new Set(m)).join(' ')}`);
          m.forEach((x) => seen.add(x));
        }
      });
      const all = ((root as HTMLElement).innerText || '').match(/\{\{[^}]+\}\}/g) || [];
      for (const x of Array.from(new Set(all))) {
        if (leakedSamples.length >= 6) break;
        if (!seen.has(x)) leakedSamples.push(x);
      }
    }
    const leakedPlaceholders = leakedSamples.length > 0;

    // Best-effort "rendered with data" signals.
    const canvases = root ? root.querySelectorAll('canvas').length : 0; // charts + maps
    const kpis = root ? root.querySelectorAll('.kpi-card').length : 0;
    const tables = root ? Array.from(root.querySelectorAll('table')) : [];
    const tableWithRows = tables.filter((t) => t.querySelectorAll('tbody tr').length > 0).length;

    const okCount = canvases + kpis + tableWithRows;
    const totalComponents = okCount + errorCards.length;

    let state: 'ok' | 'empty' | 'broken';
    if (neverRendered || brokenComponents.length > 0 || leakedPlaceholders) {
      state = 'broken';
    } else if (okCount > 0) {
      state = 'ok';
    } else {
      state = 'empty';
    }

    return {
      state,
      totalComponents,
      okCount,
      emptyCount: Math.max(0, totalComponents - okCount - brokenComponents.length),
      brokenComponents,
      leakedSamples,
      leakedPlaceholders,
      neverRendered,
    };
  });
}
