import type { Page } from '@playwright/test';
import { within } from './resilience';
import type { OnScreenRule } from './types';

/**
 * On-screen checks: simple things a user would notice on the page as drawn,
 * read once per filter combination after the page and its lazy charts have
 * rendered. Deliberately NOT a data-quality check: no source data, nothing
 * opened or drilled into, only what is already on screen.
 *
 *   junk-text         NaN, undefined, Infinity, null or [object Object] shown as text
 *   over-100-percent  a percentage above 100%
 *   negative-number   a negative number
 *
 * What is read: table rows on screen (the table's current page), KPI card
 * values, and the values each chart drew (Chart.js keeps them on the chart).
 * Everything else (maps, info boxes, free text) is checked for junk text only:
 * a sentence like "up 150% on last year" is not an error.
 *
 * Kept quiet on purpose. A value counts as a percentage only when it is shown
 * with "%" or sits in a column or series whose name says "%". Columns, series
 * and KPIs named as a change, difference or trend are skipped (they can be
 * negative or above 100%), so are "% of target" ones (above 100% is good news),
 * and so are negatives on population pyramids and waterfall charts (drawn that
 * way). Coverage against population estimates CAN exceed 100% for real — that
 * is still flagged, as something to check.
 */

/** One rendered component block, as read from the page. */
interface ScreenBlock {
  sIdx: number; // DOM section order == report section order (the app renders every section)
  title: string;
  junk: string[]; // text outside tables showing NaN / undefined / …
  tables: { headers: string[]; rows: string[][] }[];
  kpis: { title: string; value: string }[];
  charts: { pie: boolean; labels: string[]; datasets: { label: string; axisTitle: string; values: (number | null)[] }[] }[];
}

export interface OnScreenFinding {
  sIdx: number;
  /** Report component index; -1 when the block couldn't be matched to one. */
  cIdx: number;
  section: string;
  component: string;
  type: string;
  rule: OnScreenRule;
  count: number;
  detail: string;
}

/** Read every rendered component's visible values. Null if the page stops answering. */
export function readOnScreen(page: Page): Promise<ScreenBlock[] | null> {
  return within(page.evaluate(readPage).catch(() => null), 20_000, null);
}

/** Runs in the page: self-contained, no outside references. */
function readPage(): ScreenBlock[] {
  const JUNK = /\bNaN\b|\bundefined\b|\bInfinity\b|\[object Object\]/;
  const txt = (el: Element | null | undefined): string =>
    ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const out: ScreenBlock[] = [];
  const sections = Array.from(document.querySelectorAll('#sections-container > .section'));
  sections.forEach((sec, sIdx) => {
    // Each component renders as one top-level `.component` block (a chart that
    // hasn't been drawn yet is a `.component.chart-placeholder`).
    const blocks = Array.from(sec.querySelectorAll('.component')).filter((el) => !el.parentElement?.closest('.component'));
    for (const block of blocks) {
      const b: ScreenBlock = {
        sIdx,
        title: txt(block.querySelector('.component-title, .infobox-title, .component-error-title')),
        junk: [],
        tables: [],
        kpis: [],
        charts: [],
      };
      out.push(b);
      if (block.classList.contains('component-error')) continue; // a failed component: nothing to read

      // Junk text outside tables (table cells are checked with their column).
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n && b.junk.length < 5; n = walker.nextNode()) {
        const p = n.parentElement;
        if (!p || p.closest('table, script, style') || p.getClientRects().length === 0) continue;
        const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && JUNK.test(t)) b.junk.push(t.slice(0, 100));
      }

      // Tables: the rows on screen. Column labels come from the header grid
      // (rowspan/colspan aware), "parent · child" for grouped columns.
      block.querySelectorAll('table').forEach((table) => {
        const grid: string[][] = [];
        Array.from(table.querySelectorAll('thead tr')).forEach((tr, r) => {
          grid[r] = grid[r] || [];
          let c = 0;
          for (const th of Array.from(tr.children) as HTMLTableCellElement[]) {
            while (grid[r][c] !== undefined) c++;
            const label = txt(th.querySelector('.table-header-label')) || txt(th).replace(/[▲▼⋮]/g, '').trim();
            for (let i = 0; i < (th.rowSpan || 1); i++)
              for (let j = 0; j < (th.colSpan || 1); j++) {
                grid[r + i] = grid[r + i] || [];
                grid[r + i][c + j] = label;
              }
            c += th.colSpan || 1;
          }
        });
        const headers: string[] = [];
        const ncol = grid.reduce((m, row) => Math.max(m, row.length), 0);
        for (let c = 0; c < ncol; c++) {
          const parts: string[] = [];
          for (const row of grid) if (row[c] && parts[parts.length - 1] !== row[c]) parts.push(row[c]);
          headers.push(parts.join(' · '));
        }
        const rows = Array.from(table.querySelectorAll('tbody tr'))
          .slice(0, 500)
          .map((tr) => {
            const cells: string[] = [];
            for (const td of Array.from(tr.children) as HTMLTableCellElement[]) {
              cells.push(txt(td));
              for (let j = 1; j < (td.colSpan || 1); j++) cells.push('');
            }
            return cells;
          });
        b.tables.push({ headers, rows });
      });

      // KPI cards: the value, with the card's title.
      block.querySelectorAll('.kpi-card').forEach((card) => {
        b.kpis.push({ title: txt(card.querySelector('.kpi-card__title')), value: txt(card.querySelector('.kpi-card__value')) });
      });

      // Charts: the values Chart.js drew, per visible series.
      const Chart = (window as any).Chart;
      block.querySelectorAll('canvas').forEach((canvas) => {
        const ch = Chart?.getChart?.(canvas);
        if (!ch) return; // not a Chart.js canvas (e.g. a map)
        const type = String(ch.config?.type ?? '');
        const horizontal = ch.options?.indexAxis === 'y';
        const labels = (ch.data?.labels ?? []).map((l: unknown) => (Array.isArray(l) ? l.join(' ') : String(l ?? '')));
        const datasets = (ch.data?.datasets ?? [])
          .map((ds: any, i: number) => {
            const axis = ch.scales?.[horizontal ? ds.xAxisID || 'x' : ds.yAxisID || 'y'];
            const title = axis?.options?.title;
            // Values can come as numbers or as numeric text ("51.1"), which Chart.js draws the same.
            const num = (n: any): number | null =>
              typeof n === 'number' ? n : typeof n === 'string' && n.trim() !== '' && Number.isFinite(Number(n)) ? Number(n) : null;
            const valueOf = (v: any): number | null => {
              if (v && typeof v === 'object' && !Array.isArray(v)) return num(horizontal ? v.x : v.y);
              return Array.isArray(v) ? null : num(v); // an array is a floating [from, to] bar
            };
            return {
              visible: typeof ch.isDatasetVisible === 'function' ? ch.isDatasetVisible(i) : true,
              label: String(ds.label ?? ''),
              axisTitle: title?.display ? (Array.isArray(title.text) ? title.text.join(' ') : String(title.text ?? '')) : '',
              values: (ds.data ?? []).map(valueOf),
            };
          })
          .filter((d: any) => d.visible)
          .map(({ label, axisTitle, values }: any) => ({ label, axisTitle, values }));
        b.charts.push({ pie: type === 'pie' || type === 'doughnut', labels, datasets });
      });
    }
  });
  return out;
}

// ---- Rules (run in Node, where each block's report component and type are known) ----

/** Named as a change, difference or trend: can be negative or above 100%. */
const CHANGE = /chang|growth|increase|decrease|differ|variance|trend|\bvs\b|versus|deviation|\bgap\b|delta|Δ|compar|\bnet\b|balance|adjust|surplus|deficit/i;
/** Progress against a target: above 100% is good news, not an error. */
const TARGET = /target|achiev/i;
const PERCENT = /%|percent/i;
const JUNK = /\bNaN\b|\bundefined\b|\bInfinity\b|\[object Object\]/;
/** A table cell or KPI value that is nothing but junk (also catches a bare "null"). */
const JUNK_VALUE = /^(?:NaN|undefined|null|-?Infinity)\s*%?$/i;
const NUMERIC_CELL = /^[-−]?[\d,]+(?:\.\d+)?\s*%?$/;

interface Tok {
  value: number;
  neg: boolean;
  pct: boolean;
}

/** Numbers in a piece of text, as shown: "1,234", "45.6%", "-3", "12 (45%)". Dates and ranges ("2026-07", "10-20") don't count as negative. */
function numbersIn(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /(^|[^\w.,\-−])([-−]?)(\d[\d,]*(?:\.\d+)?)(\s?%)?/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const value = Number(m[3].replace(/,/g, ''));
    if (Number.isFinite(value)) out.push({ value, neg: !!m[2], pct: !!m[4] });
  }
  return out;
}

const fmt = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 1 });
const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

class Tally {
  count = 0;
  examples: string[] = [];
  max = -Infinity;
  add(example: string, value?: number): void {
    this.count++;
    if (this.examples.length < 3) this.examples.push(example);
    if (value != null && value > this.max) this.max = value;
  }
}

/** The order the app draws a section's components in: report order, or grouped by subsection. */
function renderOrder(section: any): number[] {
  const comps: any[] = section?.components ?? [];
  const subs: any[] = Array.isArray(section?.subsections) ? section.subsections : [];
  if (subs.length === 0) return comps.map((_, i) => i);
  const out: number[] = [];
  for (const sub of subs) comps.forEach((c, i) => c?.subsection === sub?.id && out.push(i));
  return out;
}

/**
 * Pair the blocks read from one section with the report's components: by draw
 * order when the counts agree and every shown title matches; otherwise by title.
 */
function matchBlocks(blocks: ScreenBlock[], section: any): number[] {
  const comps: any[] = section?.components ?? [];
  const order = renderOrder(section);
  const title = (i: number) => String(comps[i]?.title ?? '');
  if (blocks.length === order.length && blocks.every((b, k) => !b.title || !title(order[k]) || norm(b.title) === norm(title(order[k]))))
    return order;
  const taken = new Set<number>();
  return blocks.map((b) => {
    const i = b.title ? order.find((ci) => !taken.has(ci) && norm(title(ci)) === norm(b.title)) : undefined;
    if (i == null) return -1;
    taken.add(i);
    return i;
  });
}

/**
 * Where each report component sits on screen: "s.c" (section, component index in
 * the report) → its section and position among that section's component blocks.
 * Used to photograph a single component.
 */
export function blockIndex(blocks: ScreenBlock[], rep: any): Map<string, { sIdx: number; n: number }> {
  const out = new Map<string, { sIdx: number; n: number }>();
  const bySection = new Map<number, ScreenBlock[]>();
  for (const b of blocks) {
    if (!bySection.has(b.sIdx)) bySection.set(b.sIdx, []);
    bySection.get(b.sIdx)!.push(b);
  }
  for (const [sIdx, sBlocks] of bySection) {
    matchBlocks(sBlocks, rep?.sections?.[sIdx] ?? {}).forEach((cIdx, n) => {
      if (cIdx >= 0) out.set(`${sIdx}.${cIdx}`, { sIdx, n });
    });
  }
  return out;
}

/** Apply the on-screen rules to what was read; one finding per component per rule. */
export function onScreenFindings(blocks: ScreenBlock[], rep: any): OnScreenFinding[] {
  const sections: any[] = rep?.sections ?? [];
  const findings: OnScreenFinding[] = [];
  const bySection = new Map<number, ScreenBlock[]>();
  for (const b of blocks) {
    if (!bySection.has(b.sIdx)) bySection.set(b.sIdx, []);
    bySection.get(b.sIdx)!.push(b);
  }
  for (const [sIdx, sBlocks] of bySection) {
    const section = sections[sIdx] ?? {};
    const mapping = matchBlocks(sBlocks, section);
    sBlocks.forEach((b, k) => {
      const cIdx = mapping[k];
      const comp = cIdx >= 0 ? (section.components ?? [])[cIdx] : undefined;
      const type = String(comp?.type ?? '');
      const name = String(comp?.title || b.title || b.kpis.map((x) => x.title).filter(Boolean).join(' / ') || comp?.type || '(untitled)');
      const tallies = new Map<OnScreenRule, Tally>();
      const hit = (rule: OnScreenRule, example: string, value?: number) => {
        if (!tallies.has(rule)) tallies.set(rule, new Tally());
        tallies.get(rule)!.add(example, value);
      };

      for (const j of b.junk) hit('junk-text', `“${j}”`);

      for (const t of b.tables) {
        for (const row of t.rows) {
          const rowLabel = row.find((c) => c && !NUMERIC_CELL.test(c)) ?? '';
          row.forEach((cell, ci) => {
            if (!cell) return;
            const header = t.headers[ci] ?? '';
            const where = [cell === rowLabel ? '' : rowLabel, header].filter(Boolean).join(' · ') || name;
            if (JUNK_VALUE.test(cell) || JUNK.test(cell)) return hit('junk-text', `${where} = “${cell}”`);
            if (CHANGE.test(header)) return;
            const toks = numbersIn(cell);
            for (const tok of toks) {
              const pct = tok.pct || (PERCENT.test(header) && toks.length === 1 && NUMERIC_CELL.test(cell));
              if (pct && !tok.neg && tok.value > 100 && !TARGET.test(header)) hit('over-100-percent', `${where} = ${cell}`, tok.value);
              if (tok.neg && tok.value > 0) hit('negative-number', `${where} = ${cell}`);
            }
          });
        }
      }

      for (const kpi of b.kpis) {
        const where = kpi.title || name;
        if (!kpi.value) continue;
        if (JUNK_VALUE.test(kpi.value) || JUNK.test(kpi.value)) {
          hit('junk-text', `${where} = “${kpi.value}”`);
          continue;
        }
        if (CHANGE.test(where)) continue;
        for (const tok of numbersIn(kpi.value)) {
          if (tok.pct && !tok.neg && tok.value > 100 && !TARGET.test(where)) hit('over-100-percent', `${where} = ${kpi.value}`, tok.value);
          if (tok.neg && tok.value > 0) hit('negative-number', `${where} = ${kpi.value}`);
        }
      }

      const negativesDrawnOnPurpose = type === 'pyramid' || type === 'waterfall' || CHANGE.test(name);
      for (const chart of b.charts) {
        for (const ds of chart.datasets) {
          if (CHANGE.test(ds.label)) continue;
          const pct =
            !chart.pie &&
            (PERCENT.test(ds.label) || PERCENT.test(ds.axisTitle) || (chart.datasets.length === 1 && PERCENT.test(name))) &&
            !TARGET.test(`${ds.label} ${name}`) &&
            !CHANGE.test(name);
          ds.values.forEach((v, i) => {
            if (v == null || !Number.isFinite(v)) return;
            const where = [chart.labels[i], ds.label].filter(Boolean).join(' · ') || name;
            if (pct && v > 100) hit('over-100-percent', `${where} = ${fmt(v)}%`, v);
            if (v < 0 && !negativesDrawnOnPurpose) hit('negative-number', `${where} = ${fmt(v)}`);
          });
        }
      }

      for (const [rule, t] of tallies) {
        const eg = ` — e.g. ${t.examples.join('; ')}`;
        const detail =
          rule === 'junk-text'
            ? `${t.count} place${t.count === 1 ? '' : 's'} show broken text${eg}`
            : rule === 'over-100-percent'
              ? `${t.count} value${t.count === 1 ? '' : 's'} over 100% (highest ${fmt(t.max)}%)${eg}`
              : `${t.count} negative value${t.count === 1 ? '' : 's'}${eg}`;
        findings.push({
          sIdx,
          cIdx,
          section: String(section.title || section.id || ''),
          component: name,
          type,
          rule,
          count: t.count,
          detail,
        });
      }
    });
  }
  return findings;
}
