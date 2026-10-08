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

    let thead = '<tr><th class="sech">Section</th><th class="comph">Component</th>';
    for (const combo of combos) {
      const disp = combo.length > 30 ? `${combo.slice(0, 29)}…` : combo;
      thead += `<th class="combo"><div><span title="${esc(combo)}">${esc(disp)}</span></div></th>`;
    }
    thead += '</tr>';

    // Combo-status row: one dot per combo (its roll-up state from the summary),
    // so report-level breakage (e.g. leaked placeholders) shows red in the grid
    // even when every component cell underneath is green.
    let tbody = '<tr class="status-row"><td class="sec"></td><td class="comp">— combo status —</td>';
    for (const combo of combos) {
      const s = combosForReport.find((x) => x.comboLabel === combo);
      const color = s ? (CELL as Record<string, string>)[s.state] || 'transparent' : 'transparent';
      const title = s && s.state === 'broken' ? ` title="${esc(s.brokenComponents || 'broken')}"` : '';
      tbody += `<td class="cell"${title}><span class="dot" style="background:${color}"></span></td>`;
    }
    tbody += '</tr>';

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

    const rc: Record<string, number> = { ok: 0, broken: 0, empty: 0 };
    for (const r of rows) rc[r.state] = (rc[r.state] ?? 0) + 1;

    // Broken-components detail: group broken cells by component, with the error
    // message(s) and which combos each broke under.
    const brokenRows = rows.filter((r) => r.state === 'broken');
    let brokenHtml = '';
    if (brokenRows.length > 0) {
      const byComp = new Map<
        string,
        { section: string; component: string; combos: Set<string>; errors: Set<string> }
      >();
      for (const r of brokenRows) {
        const k = `${r.section}${SEP}${r.component}`;
        if (!byComp.has(k))
          byComp.set(k, { section: r.section, component: r.component, combos: new Set(), errors: new Set() });
        const g = byComp.get(k)!;
        g.combos.add(r.comboLabel);
        if (r.error) g.errors.add(r.error);
      }
      const items = [...byComp.values()]
        .map((g) => {
          const errHtml = g.errors.size
            ? [...g.errors].map((e) => `<div class="err">${esc(e)}</div>`).join('')
            : '<div class="err err-none">Failed to load data (no error detail returned)</div>';
          const combosTxt = [...g.combos].map((c) => `<code>${esc(c)}</code>`).join(', ');
          return `<li><div class="bk-head">${g.section ? `<span class="bk-sec">${esc(g.section)}</span> ` : ''}<b>${esc(g.component)}</b></div>${errHtml}<div class="bk-combos">under: ${combosTxt}</div></li>`;
        })
        .join('');
      brokenHtml = `<h3 class="bk-title">⚠ Broken components (${byComp.size})</h3><ul class="broken-list">${items}</ul>`;
    }

    // Combos broken with no component-level detail (e.g. leaked {{placeholder}},
    // report-level timeout): show the combo and its recorded reason.
    const compBrokenCombos = new Set(brokenRows.map((r) => r.comboLabel));
    const comboLevel = combosForReport.filter(
      (s) => s.state === 'broken' && !compBrokenCombos.has(s.comboLabel),
    );
    if (comboLevel.length > 0) {
      const items = comboLevel
        .map(
          (cb) =>
            `<li><div class="bk-head"><code>${esc(cb.comboLabel)}</code></div><div class="err">${esc(cb.brokenComponents || 'broken (no detail recorded)')}</div></li>`,
        )
        .join('');
      brokenHtml += `<h3 class="bk-title">⚠ Broken combos — report-level (${comboLevel.length})</h3><ul class="broken-list">${items}</ul>`;
    }

    reportSections.push(`
      <section class="report">
        <h2>${esc(reportId)}</h2>
        <p class="meta">${combos.length} combos · ${compKeys.length} components ·
          <span class="good">${rc.ok} ok</span> / <span class="bad">${rc.broken} broken</span> / <span class="muted">${rc.empty} empty</span> cells ·
          <span class="${brokenCombos ? 'bad' : 'good'}">${brokenCombos} broken combo(s)</span></p>
        <div class="tablewrap"><table>${thead}${tbody}</table></div>
        ${brokenHtml}
      </section>`);
  }

  const totals: Record<string, number> = { ok: 0, broken: 0, empty: 0 };
  for (const c of comps) totals[c.state] = (totals[c.state] ?? 0) + 1;
  const totalBrokenCombos = summary.filter((s) => s.state === 'broken').length;

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
  /* Diagonal combo headers: transparent + no side borders so the angled labels
     aren't occluded by the next column's cell, and no vertical line cuts them. */
  th.combo{height:150px;padding:0;border:none;background:transparent;white-space:nowrap}
  th.combo>div{width:30px;transform:translate(22px,55px) rotate(315deg)}
  th.combo>div>span{border-bottom:1px solid #bbb;padding:5px 10px;font-weight:600;font-size:11px;color:#111}
  /* Frozen label columns (stay put during horizontal scroll). */
  th.sech,th.comph{position:sticky;background:#f9fafb;vertical-align:bottom;font-weight:700;z-index:2}
  th.sech{left:0} th.comph{left:150px}
  td.sec,td.comp{position:sticky;background:#fff;z-index:1}
  td.sec{left:0;color:#6b7280;font-weight:600;max-width:150px;overflow:hidden;text-overflow:ellipsis}
  td.comp{left:150px;max-width:340px;overflow:hidden;text-overflow:ellipsis}
  td.cell{border:1px solid #eee;width:30px;text-align:center;padding:4px 0}
  tr.status-row td{background:#fafafa;border-bottom:2px solid #d1d5db}
  tr.status-row td.comp,tr.status-row td.sec{background:#fafafa;font-size:11px;color:#6b7280;font-weight:600}
  .dot{display:inline-block;width:14px;height:14px;border-radius:3px}
  .good{color:#16a34a;font-weight:600}.bad{color:#dc2626;font-weight:600}.muted{color:#9ca3af;font-weight:600}
  .summary{font-size:14px;margin:8px 0 16px}
  .chip{display:inline-block;padding:2px 9px;border-radius:11px;margin-right:6px;font-weight:600;font-size:13px}
  .chip.good{background:#dcfce7;color:#166534}
  .chip.bad{background:#fee2e2;color:#991b1b}
  .chip.muted{background:#f3f4f6;color:#6b7280}
  .bk-title{font-size:13px;margin:16px 0 6px;color:#991b1b}
  .broken-list{list-style:none;padding:0;margin:0 0 10px;max-width:1000px}
  .broken-list>li{border-left:3px solid #dc2626;background:#fef2f2;padding:8px 12px;margin:0 0 8px;border-radius:4px}
  .bk-head{font-size:13px}
  .bk-sec{color:#6b7280;font-weight:600}
  .err{font-family:ui-monospace,monospace;font-size:12px;color:#7f1d1d;margin:4px 0;white-space:pre-wrap;word-break:break-word}
  .err-none{color:#9ca3af;font-style:italic}
  .bk-combos{font-size:12px;color:#555;margin-top:2px}
  .bk-combos code{background:#fff;border:1px solid #fecaca;border-radius:3px;padding:0 4px}
</style></head><body>
  <h1>Report functional audit — component × filter grid</h1>
  <p class="legend">Generated ${esc(new Date().toLocaleString())} ·
    <span class="dot" style="background:${CELL.ok}"></span>ok
    <span class="dot" style="background:${CELL.broken}"></span>broken
    <span class="dot" style="background:${CELL.empty}"></span>empty
  </p>
  <p class="summary"><b>${comps.length}</b> component checks ·
    <span class="chip good">● ${totals.ok} ok</span>
    <span class="chip bad">● ${totals.broken} broken</span>
    <span class="chip muted">● ${totals.empty} empty</span>
    · <span class="${totalBrokenCombos ? 'bad' : 'good'}">${totalBrokenCombos} of ${summary.length} combos broken</span></p>
  ${reportSections.join('\n')}
</body></html>`;

  const out = join(dir, 'report.html');
  writeFileSync(out, html, 'utf8');
  console.log(`✓ Component grid → ${out}`);

  // Conclusive, colored summary (Playwright still prints its own passed/failed).
  const tty = !!process.stdout.isTTY;
  const col = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  console.log('');
  console.log(
    `${col('1', 'Audit summary')} — ${byReport.size} report(s) · ${summary.length} combos · ${comps.length} component checks`,
  );
  console.log(
    `  ${col('32', '●')} ${totals.ok} ok   ${col('31', '●')} ${totals.broken} broken   ${col('90', '●')} ${totals.empty} empty`,
  );
  console.log(
    `  ${totalBrokenCombos > 0 ? col('31', '✗') : col('32', '✓')} ${totalBrokenCombos} of ${summary.length} combo(s) broken`,
  );
}
