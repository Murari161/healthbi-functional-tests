import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDir } from './config';
import type { ComponentResultRow } from './types';

/**
 * Generates results/report.html — a red/green grid per report: rows are
 * components (grouped by section), columns are filter combos, cells are
 * 🟩 ok / 🟥 broken / ⬜ empty. Reads the incremental components.jsonl and
 * summary.jsonl. Wired as Playwright's globalTeardown, and runnable standalone
 * via `npm run report:html`.
 */

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"]/g,
    (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }) as Record<string, string>)[c],
  );
}

const CELL = { ok: '#16a34a', empty: '#d1d5db', broken: '#dc2626' } as const;
const SEP = '\u0001';

export default async function generateHtmlReport(): Promise<void> {
  const dir = runDir();
  const comps: ComponentResultRow[] = readJsonl(join(dir, 'components.jsonl'));
  const summary = readJsonl(join(dir, 'summary.jsonl'));
  if (comps.length === 0) return;

  const byReport = new Map<string, ComponentResultRow[]>();
  for (const c of comps) {
    if (!byReport.has(c.reportId)) byReport.set(c.reportId, []);
    byReport.get(c.reportId)!.push(c);
  }

  const reportSections: string[] = [];
  for (const [reportId, rows] of byReport) {
    const combos: string[] = [];
    for (const r of rows) if (!combos.includes(r.comboLabel)) combos.push(r.comboLabel);

    const compKeys: { key: string; section: string; component: string }[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const key = `${r.section}${SEP}${r.component}`;
      if (!seen.has(key)) {
        seen.add(key);
        compKeys.push({ key, section: r.section, component: r.component });
      }
    }

    const stateMap = new Map<string, string>();
    const errMap = new Map<string, string>();
    for (const r of rows) {
      stateMap.set(`${r.section}${SEP}${r.component}${SEP}${r.comboLabel}`, r.state);
      if (r.error) errMap.set(`${r.section}${SEP}${r.component}${SEP}${r.comboLabel}`, r.error);
    }

    const combosForReport = summary.filter((s) => s.reportId === reportId);
    const brokenCombos = combosForReport.filter((s) => s.state === 'broken').length;

    let thead = '<tr><th class="sticky sech">Section</th><th class="sticky comph">Component</th>';
    for (const combo of combos) {
      const disp = combo.length > 30 ? `${combo.slice(0, 29)}…` : combo;
      thead += `<th class="combo sticky"><div><span title="${esc(combo)}">${esc(disp)}</span></div></th>`;
    }
    thead += '</tr>';

    let tbody = '';
    let lastSection = '';
    for (const ck of compKeys) {
      tbody += '<tr>';
      tbody += `<td class="sec">${ck.section !== lastSection ? esc(ck.section) : ''}</td>`;
      lastSection = ck.section;
      tbody += `<td class="comp" title="${esc(ck.component)}">${esc(ck.component)}</td>`;
      for (const combo of combos) {
        const st = stateMap.get(`${ck.key}${SEP}${combo}`) || '';
        const err = errMap.get(`${ck.key}${SEP}${combo}`) || '';
        const color = (CELL as Record<string, string>)[st] || 'transparent';
        const title = st === 'broken' ? ` title="${esc(err || 'Failed to load data')}"` : '';
        tbody += `<td class="cell"${title}><span class="dot" style="background:${color}"></span></td>`;
      }
      tbody += '</tr>';
    }

    reportSections.push(`
      <section class="report">
        <h2>${esc(reportId)}</h2>
        <p class="meta">${combos.length} combos · ${compKeys.length} components ·
          <span class="${brokenCombos ? 'bad' : 'good'}">${brokenCombos} broken combo(s)</span></p>
        <div class="tablewrap"><table>${thead}${tbody}</table></div>
      </section>`);
  }

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Report audit — component grid</title>
<style>
  :root{color-scheme:light}
  body{font-family:Inter,system-ui,Arial,sans-serif;margin:24px;color:#111;background:#fff}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:30px 0 4px;font-family:ui-monospace,monospace}
  .meta{color:#555;font-size:13px;margin:0 0 8px}
  .legend{font-size:13px;color:#333;margin:6px 0 10px}
  .legend .dot{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-1px;margin:0 4px 0 14px}
  .tablewrap{overflow:auto;border:1px solid #e5e7eb;border-radius:8px;max-height:72vh}
  table{border-collapse:collapse;font-size:12px}
  th,td{border:1px solid #eee;padding:4px 6px;white-space:nowrap}
  th.combo{height:195px;padding:0;vertical-align:bottom;background:#f9fafb}
  th.combo>div{position:relative;width:26px;height:195px}
  th.combo>div>span{position:absolute;bottom:8px;left:50%;transform-origin:left bottom;transform:rotate(-45deg);white-space:nowrap;font-weight:600;font-size:11px}
  th.sticky{position:sticky;top:0;z-index:3;background:#f9fafb}
  td.comp,td.sec{position:sticky;left:0;background:#fff;z-index:1}
  td.comp{max-width:340px;overflow:hidden;text-overflow:ellipsis;left:150px}
  td.sec{color:#6b7280;font-weight:600;max-width:150px;overflow:hidden;text-overflow:ellipsis}
  th.sech{left:0;z-index:4} th.comph{left:150px;z-index:4}
  .cell{text-align:center}
  .dot{display:inline-block;width:14px;height:14px;border-radius:3px}
  .good{color:#16a34a;font-weight:600}.bad{color:#dc2626;font-weight:600}
</style></head><body>
  <h1>Report functional audit — component × filter grid</h1>
  <p class="legend">Generated ${esc(new Date().toLocaleString())} ·
    <span class="dot" style="background:${CELL.ok}"></span>ok
    <span class="dot" style="background:${CELL.broken}"></span>broken
    <span class="dot" style="background:${CELL.empty}"></span>empty
  </p>
  ${reportSections.join('\n')}
</body></html>`;

  const out = join(dir, 'report.html');
  writeFileSync(out, html, 'utf8');
  console.log(`✓ Component grid → ${out}`);
}
