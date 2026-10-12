import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runDir } from './config';
import type { ComponentResultRow, DownloadResultRow, FeedbackResultRow, StandardsResultRow } from './types';

/**
 * Generates results/<run>/<run>.html — one red/green grid per report: rows are
 * components (grouped by section), columns are the numbered filter combinations
 * (Combo 1…N), cells are ok / broken / empty. Under each grid a Combination key
 * lists exactly which filters each combo ran with. Reads the incremental
 * *.jsonl files. Wired as Playwright's globalTeardown, and runnable standalone
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
/** Leakage: raw {{placeholder}} text reached the user (page works, template didn't). */
const LEAK = '#9333ea';
const SEP = '\u0001';

/**
 * Row identity for the grid: positional (section #, component #) when available,
 * so a component whose TITLE interpolates the filter (e.g. "…FOR Q1 2026") still
 * maps to one row across all combos. Falls back to section+title for older runs.
 */
function keyOf(r: { sectionIndex?: number; componentIndex?: number; section: string; component: string }): string {
  return r.sectionIndex != null && r.componentIndex != null
    ? `i${r.sectionIndex}.${r.componentIndex}`
    : `${r.section}${SEP}${r.component}`;
}

/**
 * "region=Acholi & year=2026" → [["region","Acholi"],["year","2026"]]. Splits
 * only on " & " that is followed by "name=", so a value containing " & " (e.g.
 * a facility name) stays intact. "baseline" → [].
 */
function parseCombo(s: string): [string, string][] {
  if (!s || s === 'baseline') return [];
  return s.split(/ & (?=[A-Za-z_][\w.-]*=)/).map((part): [string, string] => {
    const i = part.indexOf('=');
    return i < 0 ? [part, ''] : [part.slice(0, i), part.slice(i + 1)];
  });
}

export default async function generateHtmlReport(playwrightConfig?: unknown): Promise<void> {
  // When invoked as Playwright's globalTeardown (Playwright passes its config as
  // an argument), only render if the run actually started — globalSetup sets
  // AUDIT_RUN_ID on success. Otherwise a failed setup (e.g. expired session)
  // would re-render the PREVIOUS run and print its summary, which reads as if
  // the new run produced results. Standalone `npm run report:html` passes no
  // argument and always renders the most recent run via the marker.
  if (playwrightConfig !== undefined && !process.env.AUDIT_RUN_ID) return;

  const dir = runDir();
  const comps: ComponentResultRow[] = readJsonl(join(dir, 'components.jsonl'));
  const summary = readJsonl(join(dir, 'summary.jsonl'));
  const dls: DownloadResultRow[] = readJsonl(join(dir, 'downloads.jsonl'));
  const sts: StandardsResultRow[] = readJsonl(join(dir, 'standards.jsonl'));
  const fbs: FeedbackResultRow[] = readJsonl(join(dir, 'feedback.jsonl'));
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
    const comboNo = new Map<string, number>(combos.map((c, i) => [c, i + 1]));

    const compKeys: { key: string; section: string; component: string }[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const key = keyOf(r);
      if (!seen.has(key)) {
        seen.add(key);
        compKeys.push({ key, section: r.section, component: r.component });
      }
    }

    const stateMap = new Map<string, string>();
    const errMap = new Map<string, string>();
    for (const r of rows) {
      stateMap.set(`${keyOf(r)}${SEP}${r.comboLabel}`, r.state);
      if (r.error) errMap.set(`${keyOf(r)}${SEP}${r.comboLabel}`, r.error);
    }

    const combosForReport = summary.filter((s) => s.reportId === reportId);
    const comboSummary = (c: string) => combosForReport.find((x) => x.comboLabel === c);
    const brokenCombos = combosForReport.filter((s) => s.state === 'broken').length;
    /** The full filter set a combo ran with (falls back to its label on older runs). */
    const fullText = (c: string): string =>
      comboSummary(c)?.effective || (c === 'baseline' ? 'baseline — no filters applied by the test' : c);
    /** Inline reference to a combo, matching its grid column; hover shows the full filter set. */
    const comboRef = (c: string): string =>
      `<code class="cref" title="${esc(fullText(c))}">Combo ${comboNo.get(c) ?? '?'}</code>`;

    // Download status per component (downloads run once per report, on baseline).
    const rdl = dls.filter((d) => d.reportId === reportId);
    const rdlFailed = rdl.filter((d) => !d.ok);
    const normTitle = (t: string) =>
      t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const DL_TYPES = ['table', 'table_advanced', 'bar', 'line', 'bar_line', 'pie', 'pyramid', 'waterfall'];
    const dlStatusFor = (title: string, type: string): { cls: string; text: string; tip: string } => {
      const n = normTitle(title);
      const matches = n ? rdl.filter((d) => (d.label || d.filename).toLowerCase().includes(n)) : [];
      if (matches.length > 0) {
        const bad = matches.filter((m) => !m.ok);
        return bad.length
          ? { cls: 'bad', text: '✗ failed', tip: bad.map((m) => m.error).join('; ') }
          : { cls: 'good', text: '✓ ok', tip: matches.map((m) => m.filename).join('; ') };
      }
      return DL_TYPES.includes(type)
        ? { cls: 'warnt', text: 'missing', tip: 'no download control found for this component' }
        : { cls: 'na', text: '–', tip: 'no download for this component type by design' };
    };

    // Feedback status per component (checked once per report, on baseline).
    const rfb = fbs.filter((f) => f.reportId === reportId);
    const hasFb = rfb.length > 0;
    const fbBtn = new Map<string, FeedbackResultRow>();
    const fbModalBad = new Map<string, FeedbackResultRow>();
    for (const f of rfb) {
      const k = keyOf(f);
      if (f.check === 'button' && f.scope === 'visual') fbBtn.set(k, f);
      if (f.check === 'modal' && f.scope === 'visual' && f.state === 'broken') fbModalBad.set(k, f);
    }
    const fbStatusFor = (key: string): { cls: string; text: string; tip: string } => {
      const m = fbModalBad.get(key);
      if (m) return { cls: 'bad', text: '✗ failed', tip: `Feedback button is there, but the form misbehaved: ${m.detail}` };
      const b = fbBtn.get(key);
      if (!b) return { cls: 'na', text: '–', tip: 'not checked' };
      if (b.state === 'ok') return { cls: 'good', text: '✓ ok', tip: b.detail || 'Feedback button present' };
      if (b.state === 'missing') return { cls: 'warnt', text: 'missing', tip: b.detail };
      return { cls: 'na', text: '–', tip: b.detail || 'not checkable' };
    };

    // Header: plain numbered combo columns; the Combination key below spells
    // each one out (hovering a header shows its filters too).
    let thead = '<thead><tr><th class="sech">Section</th><th class="comph">Component</th><th class="dlh">Downloads</th>';
    if (hasFb) thead += '<th class="fbh">Feedback</th>';
    combos.forEach((c, i) => {
      thead += `<th class="combo" title="${esc(`Combination ${i + 1}: ${fullText(c)}`)}"><span class="cl">Combo</span><span class="cn">${i + 1}</span></th>`;
    });
    thead += '</tr></thead>';

    // Combo-status row: one dot per combo (its roll-up state from the summary),
    // so report-level breakage (e.g. leaked placeholders) shows red in the grid
    // even when every component cell underneath is green.
    let tbody = `<tbody><tr class="status-row"><td class="sec"></td><td class="comp">— combo status —</td><td class="dlcell"></td>${hasFb ? '<td class="fbcell"></td>' : ''}`;
    for (const combo of combos) {
      const s = comboSummary(combo);
      const color = s
        ? s.state === 'broken' && s.leakedPlaceholders
          ? LEAK
          : (CELL as Record<string, string>)[s.state] || 'transparent'
        : 'transparent';
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
      const firstRow = rows.find((r) => keyOf(r) === ck.key);
      const dstat = dlStatusFor(ck.component, firstRow?.type || '');
      tbody += `<td class="dlcell ${dstat.cls}" title="${esc(dstat.tip)}">${dstat.text}</td>`;
      if (hasFb) {
        const fstat = fbStatusFor(ck.key);
        tbody += `<td class="fbcell ${fstat.cls}" title="${esc(fstat.tip)}">${fstat.text}</td>`;
      }
      for (const combo of combos) {
        const st = stateMap.get(`${ck.key}${SEP}${combo}`) || '';
        const err = errMap.get(`${ck.key}${SEP}${combo}`) || '';
        const color = (CELL as Record<string, string>)[st] || 'transparent';
        const title = st === 'broken' ? ` title="${esc(err || 'Failed to load data')}"` : '';
        tbody += `<td class="cell"${title}><span class="dot" style="background:${color}"></span></td>`;
      }
      tbody += '</tr>';
    }
    tbody += '</tbody>';

    // Combination key: one row per combo, one column per filter, so values line
    // up and what changed between combos is visible at a glance.
    const filterKeys: string[] = [];
    for (const c of combos)
      for (const [k] of [...parseCombo(comboSummary(c)?.effective || ''), ...parseCombo(c)])
        if (!filterKeys.includes(k)) filterKeys.push(k);
    let keyHtml = `<h3 class="key-title">Combination key — the filters each Combo column ran with</h3><table class="ckey"><thead><tr><th>Combination</th>${filterKeys
      .map((k) => `<th>${esc(k)}</th>`)
      .join('')}<th>Result</th></tr></thead><tbody>`;
    combos.forEach((c, i) => {
      const s = comboSummary(c);
      const eff = new Map(parseCombo(s?.effective || ''));
      const applied = new Map(parseCombo(c));
      keyHtml += `<tr><td class="cname">Combination ${i + 1}${c === 'baseline' ? ' <span class="base">baseline</span>' : ''}</td>`;
      for (const k of filterKeys) {
        const v = eff.get(k) ?? '';
        if (applied.has(k)) keyHtml += `<td class="set"><b>${esc(applied.get(k))}</b></td>`;
        else if (!v || v === '—') keyHtml += '<td class="unset">—</td>';
        else keyHtml += `<td class="dflt" title="the app's own default — not chosen by the test">${esc(v)}</td>`;
      }
      const st: string = s?.state ?? '';
      const leak = st === 'broken' && s?.leakedPlaceholders;
      const color = leak ? LEAK : (CELL as Record<string, string>)[st] || 'transparent';
      const label = leak ? 'leakage' : st || 'not run';
      const nBroken = s ? Math.max(0, s.totalComponents - s.okCount - s.emptyCount) : 0;
      const counts = s ? `${s.okCount} ok · ${s.emptyCount} empty · ${nBroken} broken` : '';
      const tip = st === 'broken' ? ` title="${esc(s?.brokenComponents || 'broken')}"` : '';
      keyHtml += `<td class="cres"${tip}><span class="dot" style="background:${color}"></span> ${esc(label)}${counts ? ` <span class="cnt">(${counts})</span>` : ''}</td></tr>`;
    });
    keyHtml += `</tbody></table><p class="key-note"><b>bold</b> = set by this combination · plain grey = the app's own default (not chosen by the test) · — = filter not applied</p>`;

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
        const k = keyOf(r);
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
          const combosTxt = [...g.combos].map(comboRef).join(' ');
          return `<li><div class="bk-head">${g.section ? `<span class="bk-sec">${esc(g.section)}</span> ` : ''}<b>${esc(g.component)}</b></div>${errHtml}<div class="bk-combos">under: ${combosTxt}</div></li>`;
        })
        .join('');
      brokenHtml = `<h3 class="bk-title">⚠ Broken components (${byComp.size})</h3><ul class="broken-list">${items}</ul>`;
    }

    // Leakage: raw {{placeholder}} text reached the user. Its own category.
    const compBrokenCombos = new Set(brokenRows.map((r) => r.comboLabel));
    const leakedList = combosForReport.filter((s) => s.state === 'broken' && s.leakedPlaceholders);
    if (leakedList.length > 0) {
      const items = leakedList
        .map(
          (cb) =>
            `<li><div class="bk-head">${comboRef(cb.comboLabel)} <span class="bk-sec">${esc(fullText(cb.comboLabel))}</span></div><div class="err">${esc(cb.brokenComponents || 'leaked {{placeholder}}')}</div></li>`,
        )
        .join('');
      brokenHtml += `<h3 class="bk-title leak">⬤ Leakage — raw {{placeholder}} shown to the user (${leakedList.length})</h3><ul class="broken-list leak">${items}</ul>`;
    }

    // Other report-level breakage (whole-report timeout / fetch failure):
    // broken combos with no failing component query and no leak.
    const comboLevel = combosForReport.filter(
      (s) => s.state === 'broken' && !s.leakedPlaceholders && !compBrokenCombos.has(s.comboLabel),
    );
    if (comboLevel.length > 0) {
      const items = comboLevel
        .map(
          (cb) =>
            `<li><div class="bk-head">${comboRef(cb.comboLabel)} <span class="bk-sec">${esc(fullText(cb.comboLabel))}</span></div><div class="err">${esc(cb.brokenComponents || 'broken (no detail recorded)')}</div></li>`,
        )
        .join('');
      brokenHtml += `<h3 class="bk-title">⚠ Broken combos — report-level (${comboLevel.length})</h3><ul class="broken-list">${items}</ul>`;
    }

    // Standards warnings (house style; never fail the test).
    const rst = sts.filter((t) => t.reportId === reportId);
    if (rst.length > 0) {
      const items = rst
        .map(
          (t) =>
            `<li><div class="bk-head">${t.section ? `<span class="bk-sec">${esc(t.section)}</span> ` : ''}<b>${esc(t.component)}</b> <span class="bk-sec">(${esc(t.type)} · ${esc(t.rule)})</span></div><div class="err">${esc(t.detail)}</div></li>`,
        )
        .join('');
      brokenHtml += `<h3 class="bk-title std">☰ Standards warnings (${rst.length})</h3><ul class="broken-list std">${items}</ul>`;
    }

    // Failed-download details (statuses per component are in the Downloads column).
    if (rdlFailed.length > 0) {
      const items = rdlFailed
        .map(
          (d2) =>
            `<li><div class="bk-head"><b>${esc(d2.label)}</b> <span class="bk-sec">(${esc(d2.kind)})</span></div><div class="err">${esc(d2.error || 'download failed')}</div></li>`,
        )
        .join('');
      brokenHtml += `<h3 class="bk-title">⬇ Failed downloads (${rdlFailed.length})</h3><ul class="broken-list">${items}</ul>`;
    }

    // Feedback details: form problems (red), missing buttons grouped by reason
    // (amber), and degraded-but-working buttons (blue notes).
    const fbMissing = rfb.filter((f) => f.check === 'button' && f.state === 'missing');
    const fbModalBroken = rfb.filter((f) => f.check === 'modal' && f.state === 'broken');
    const fbNotes = rfb.filter((f) => f.check === 'button' && f.state === 'ok' && f.detail);
    const where = (f: FeedbackResultRow) =>
      f.scope === 'report'
        ? 'report header'
        : f.scope === 'section'
          ? `section “${esc(f.section)}”`
          : `${f.section ? `<span class="bk-sec">${esc(f.section)}</span> ` : ''}<b>${esc(f.component)}</b>${f.type ? ` <span class="bk-sec">(${esc(f.type)})</span>` : ''}`;
    if (fbModalBroken.length > 0) {
      const items = fbModalBroken
        .map((f) => `<li><div class="bk-head">${f.scope} Feedback form — ${where(f)}</div><div class="err">${esc(f.detail)}</div></li>`)
        .join('');
      brokenHtml += `<h3 class="bk-title">💬 Feedback form problems (${fbModalBroken.length})</h3><ul class="broken-list">${items}</ul>`;
    }
    if (fbMissing.length > 0) {
      const byReason = new Map<string, FeedbackResultRow[]>();
      for (const f of fbMissing) {
        if (!byReason.has(f.detail)) byReason.set(f.detail, []);
        byReason.get(f.detail)!.push(f);
      }
      const items = [...byReason.entries()]
        .map(([reason, fs]) => `<li><div class="err">${esc(reason)}</div><div class="bk-combos">${fs.map(where).join(' · ')}</div></li>`)
        .join('');
      brokenHtml += `<h3 class="bk-title warnt">💬 Feedback button missing (${fbMissing.length})</h3><ul class="broken-list warnt">${items}</ul>`;
    }
    if (fbNotes.length > 0) {
      const items = fbNotes.map((f) => `<li><div class="bk-head">${where(f)}</div><div class="err">${esc(f.detail)}</div></li>`).join('');
      brokenHtml += `<h3 class="bk-title std">💬 Feedback notes (${fbNotes.length})</h3><ul class="broken-list std">${items}</ul>`;
    }

    const fbVisual = rfb.filter((f) => f.check === 'button' && f.scope === 'visual' && f.state !== 'na');
    const fbVisualOk = fbVisual.filter((f) => f.state === 'ok').length;
    const fbModals = rfb.filter((f) => f.check === 'modal');
    const fbMeta = hasFb
      ? ` · <span class="${fbModalBroken.length ? 'bad' : fbMissing.length ? 'warnt' : 'good'}">💬 ${fbVisualOk}/${fbVisual.length} components have Feedback · form ${fbModals.length - fbModalBroken.length}/${fbModals.length} ok</span>`
      : '';

    reportSections.push(`
      <section class="report">
        <h2>${esc(reportId)}</h2>
        <p class="meta">${combos.length} combos · ${compKeys.length} components ·
          <span class="good">${rc.ok} ok</span> / <span class="bad">${rc.broken} broken</span> / <span class="muted">${rc.empty} empty</span> cells ·
          <span class="${brokenCombos ? 'bad' : 'good'}">${brokenCombos} broken combo(s)</span>${
            leakedList.length > 0 ? ` · <span class="chip leak">⬤ ${leakedList.length} leakage</span>` : ''
          }${
            comboLevel.length > 0 ? ` · <span class="chip warn">⚠ ${comboLevel.length} report-level</span>` : ''
          }${
            rdl.length > 0
              ? ` · <span class="${rdlFailed.length ? 'bad' : 'good'}">⬇ ${rdl.length - rdlFailed.length}/${rdl.length} downloads ok</span>`
              : ''
          }${fbMeta}${rst.length > 0 ? ` · <span class="chip std">☰ ${rst.length} standards</span>` : ''}</p>
        <div class="tablewrap"><table class="grid">${thead}${tbody}</table></div>
        ${keyHtml}
        ${brokenHtml}
      </section>`);
  }

  const totals: Record<string, number> = { ok: 0, broken: 0, empty: 0 };
  for (const c of comps) totals[c.state] = (totals[c.state] ?? 0) + 1;
  const totalBrokenCombos = summary.filter((s) => s.state === 'broken').length;
  // Leakage: combos where raw {{placeholder}} text reached the page.
  const leakageCombos = summary.filter((s) => s.state === 'broken' && s.leakedPlaceholders).length;
  // Report-level: broken combos with no failing component query and no leak
  // (e.g. whole-report timeout / fetch failure).
  const compBrokenKeys = new Set(
    comps.filter((c) => c.state === 'broken').map((c) => `${c.reportId}${SEP}${c.comboLabel}`),
  );
  const reportLevelBrokenCombos = summary.filter(
    (s) =>
      s.state === 'broken' &&
      !s.leakedPlaceholders &&
      !compBrokenKeys.has(`${s.reportId}${SEP}${s.comboLabel}`),
  ).length;
  const fbVisualAll = fbs.filter((f) => f.check === 'button' && f.scope === 'visual' && f.state !== 'na');
  const fbVisualAllOk = fbVisualAll.filter((f) => f.state === 'ok').length;
  const fbModalAll = fbs.filter((f) => f.check === 'modal');
  const fbModalAllOk = fbModalAll.filter((f) => f.state === 'ok').length;

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
  /* separate + zero spacing (not collapse) so borders stay put on sticky cells */
  table.grid{border-collapse:separate;border-spacing:0;font-size:12px}
  .grid th,.grid td{border-right:1px solid #eee;border-bottom:1px solid #eee;padding:4px 6px;white-space:nowrap;box-sizing:border-box}
  /* Plain horizontal header row, frozen while scrolling down the components. */
  .grid thead th{position:sticky;top:0;z-index:2;background:#f9fafb;font-weight:700;vertical-align:bottom;border-bottom:2px solid #d1d5db}
  .grid thead th.sech{left:0;z-index:4}
  .grid thead th.comph{left:150px;z-index:4}
  th.combo{width:46px;min-width:46px;text-align:center;padding:4px 2px;line-height:1.15;cursor:help}
  th.combo .cl{display:block;font-size:10px;color:#6b7280;font-weight:600}
  th.combo .cn{display:block;font-size:13px;color:#111}
  /* Pinned label-column widths: sticky offsets must equal the painted widths. */
  th.sech,td.sec{width:150px;min-width:150px;max-width:150px}
  th.comph,td.comp{width:340px;min-width:340px;max-width:340px}
  th.dlh,td.dlcell,th.fbh,td.fbcell{width:86px;min-width:86px;max-width:86px;text-align:center}
  td.dlcell,td.fbcell{font-size:11px}
  td.dlcell.good,td.fbcell.good{color:#16a34a;font-weight:600}
  td.dlcell.bad,td.fbcell.bad{color:#dc2626;font-weight:700}
  td.dlcell.warnt,td.fbcell.warnt{color:#b45309;font-weight:600}
  td.dlcell.na,td.fbcell.na{color:#9ca3af}
  td.sec,td.comp{position:sticky;background:#fff;z-index:1}
  td.sec{left:0;color:#6b7280;font-weight:600;overflow:hidden;text-overflow:ellipsis}
  td.comp{left:150px;overflow:hidden;text-overflow:ellipsis}
  td.cell{width:46px;text-align:center;padding:4px 0}
  tr.status-row td{background:#fafafa;border-bottom:2px solid #d1d5db}
  tr.status-row td.comp,tr.status-row td.sec{background:#fafafa;font-size:11px;color:#6b7280;font-weight:600}
  .dot{display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:-2px}
  .good{color:#16a34a;font-weight:600}.bad{color:#dc2626;font-weight:600}.muted{color:#9ca3af;font-weight:600}.warnt{color:#b45309;font-weight:600}
  /* Combination key */
  .key-title{font-size:13px;margin:14px 0 6px;color:#111}
  table.ckey{border-collapse:collapse;font-size:12px;margin:0 0 4px}
  table.ckey th,table.ckey td{border:1px solid #e5e7eb;padding:4px 10px;text-align:left;white-space:nowrap}
  table.ckey th{background:#f9fafb;font-weight:700}
  table.ckey td.cname{font-weight:600}
  table.ckey td.set{max-width:260px;white-space:normal}
  table.ckey td.dflt{color:#6b7280;max-width:260px;white-space:normal}
  table.ckey td.unset{color:#c0c4cc;text-align:center}
  table.ckey td.cres{white-space:nowrap}
  .ckey .base{display:inline-block;margin-left:6px;padding:0 6px;border-radius:8px;background:#f3f4f6;color:#6b7280;font-size:10px;font-weight:600}
  .ckey .cnt{color:#6b7280;font-size:11px}
  .key-note{font-size:11px;color:#6b7280;margin:0 0 10px}
  code.cref{background:#fff;border:1px solid #d1d5db;border-radius:3px;padding:0 5px;cursor:help;font-size:12px}
  .summary{font-size:14px;margin:8px 0 16px}
  .chip{display:inline-block;padding:2px 9px;border-radius:11px;margin-right:6px;font-weight:600;font-size:13px}
  .chip.good{background:#dcfce7;color:#166534}
  .chip.bad{background:#fee2e2;color:#991b1b}
  .chip.muted{background:#f3f4f6;color:#6b7280}
  .chip.warn{background:#fef3c7;color:#92400e}
  .chip.leak{background:#f3e8ff;color:#6b21a8}
  .chip.std{background:#dbeafe;color:#1e40af}
  .bk-title.std{color:#1e40af}
  .broken-list.std>li{border-left-color:#2563eb;background:#eff6ff}
  .broken-list.std .err{color:#1e3a8a}
  .bk-title.leak{color:#6b21a8}
  .broken-list.leak>li{border-left-color:#9333ea;background:#faf5ff}
  .broken-list.leak .err{color:#581c87}
  .bk-title.warnt{color:#92400e}
  .broken-list.warnt>li{border-left-color:#f59e0b;background:#fffbeb}
  .broken-list.warnt .err{color:#78350f}
  .bk-title{font-size:13px;margin:16px 0 6px;color:#991b1b}
  .broken-list{list-style:none;padding:0;margin:0 0 10px;max-width:1000px}
  .broken-list>li{border-left:3px solid #dc2626;background:#fef2f2;padding:8px 12px;margin:0 0 8px;border-radius:4px}
  .bk-head{font-size:13px}
  .bk-sec{color:#6b7280;font-weight:600}
  .err{font-family:ui-monospace,monospace;font-size:12px;color:#7f1d1d;margin:4px 0;white-space:pre-wrap;word-break:break-word}
  .err-none{color:#9ca3af;font-style:italic}
  .bk-combos{font-size:12px;color:#555;margin-top:2px}
</style></head><body>
  <h1>Report functional audit — component × filter grid</h1>
  <p class="legend">Generated ${esc(new Date().toLocaleString())} ·
    <span class="dot" style="background:${CELL.ok}"></span>ok
    <span class="dot" style="background:${CELL.broken}"></span>broken
    <span class="dot" style="background:${CELL.empty}"></span>empty
    <span class="dot" style="background:${LEAK}"></span>leakage
    <span class="dot" style="background:#fff;border:1px solid #d1d5db"></span>not checked
    · columns are filter combinations (Combo 1…N) — each report's <b>Combination key</b> lists the exact filters
  </p>
  <p class="summary"><b>${comps.length}</b> component checks ·
    <span class="chip good">● ${totals.ok} ok</span>
    <span class="chip bad">● ${totals.broken} broken</span>
    <span class="chip muted">● ${totals.empty} empty</span>
    ${leakageCombos > 0 ? `<span class="chip leak">⬤ ${leakageCombos} leakage</span>` : ''}
    ${reportLevelBrokenCombos > 0 ? `<span class="chip warn">⚠ ${reportLevelBrokenCombos} report-level</span>` : ''}
    ${dls.length > 0 ? `<span class="chip ${dls.some((d) => !d.ok) ? 'bad' : 'good'}">⬇ ${dls.filter((d) => d.ok).length}/${dls.length} downloads ok</span>` : ''}
    ${fbs.length > 0 ? `<span class="chip ${fbModalAllOk < fbModalAll.length ? 'bad' : fbVisualAllOk < fbVisualAll.length ? 'warn' : 'good'}">💬 ${fbVisualAllOk}/${fbVisualAll.length} with Feedback · form ${fbModalAllOk}/${fbModalAll.length} ok</span>` : ''}
    ${sts.length > 0 ? `<span class="chip std">☰ ${sts.length} standards</span>` : ''}
    · <span class="${totalBrokenCombos ? 'bad' : 'good'}">${totalBrokenCombos} of ${summary.length} combos broken</span></p>
  ${reportSections.join('\n')}
</body></html>`;

  // Name the file after the run folder (report name + timestamp) so it stays
  // identifiable when opened in a browser tab or shared outside its folder.
  const out = join(dir, `${basename(dir)}.html`);
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
    `  ${col('32', '●')} ${totals.ok} ok   ${col('31', '●')} ${totals.broken} broken   ${col('90', '●')} ${totals.empty} empty${
      leakageCombos > 0 ? `   ${col('35', '●')} ${leakageCombos} leakage` : ''
    }`,
  );
  console.log(
    `  ${totalBrokenCombos > 0 ? col('31', '✗') : col('32', '✓')} ${totalBrokenCombos} of ${summary.length} combo(s) broken${
      reportLevelBrokenCombos > 0 ? col('33', ` (${reportLevelBrokenCombos} report-level)`) : ''
    }`,
  );
  if (dls.length > 0) {
    const dlOk = dls.filter((d) => d.ok).length;
    console.log(
      `  ${dlOk === dls.length ? col('32', '⬇') : col('31', '⬇')} ${dlOk}/${dls.length} download(s) ok`,
    );
  }
  if (fbs.length > 0) {
    const icon =
      fbModalAllOk < fbModalAll.length ? col('31', '✉') : fbVisualAllOk < fbVisualAll.length ? col('33', '✉') : col('32', '✉');
    console.log(
      `  ${icon} feedback: ${fbVisualAllOk}/${fbVisualAll.length} component(s) have the button · form ok on ${fbModalAllOk}/${fbModalAll.length} scope(s)`,
    );
  }
  if (sts.length > 0) {
    console.log(`  ${col('34', '☰')} ${sts.length} standards warning(s)`);
  }
}
