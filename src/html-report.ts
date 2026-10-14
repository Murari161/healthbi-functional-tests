import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { config, runDir } from './config';
import { buildDefects, writeDefectsCsv, type Severity } from './defects';
import type {
  ComponentResultRow,
  DownloadResultRow,
  FeedbackResultRow,
  FilterResultRow,
  OnScreenResultRow,
  PlatformResultRow,
  StandardsResultRow,
} from './types';

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

/**
 * A collapsible list under a report. Problems (red, purple) start open; warnings
 * and notes (amber, blue) start closed — the defect list at the top sums them up.
 */
function listBlock(title: string, cls: string, items: string): string {
  const open = cls === '' || cls === 'leak';
  const c = cls ? ` ${cls}` : '';
  return `<details class="sub"${open ? ' open' : ''}><summary class="bk-title${c}">${title}</summary><ul class="broken-list${c}">${items}</ul></details>`;
}

/** Links to a defect's pictures: "section" / "component" / "page" for one; "page 1 2 3 …" for several. */
function pictureLinks(paths: string[]): string {
  const a = (p: string, text: string) => `<a href="${esc(p)}" target="_blank">${text}</a>`;
  const kind = (p: string) => (p.includes('/sections/') ? 'section' : p.includes('/components/') ? 'component' : 'page');
  if (paths.length === 0) return '';
  if (paths.length === 1) return ` · picture: ${a(paths[0], kind(paths[0]))}`;
  let n = 0;
  const shown = paths.slice(0, 9).map((p) => a(p, kind(p) === 'page' ? 'page' : String(++n)));
  return ` · pictures: ${shown.join(' ')}${paths.length > 9 ? ` (+${paths.length - 9} more in defects.csv)` : ''}`;
}

/** not_loaded (amber): the report page itself never arrived, even on a retry. */
const CELL = { ok: '#16a34a', empty: '#d1d5db', broken: '#dc2626', not_loaded: '#f59e0b' } as const;
/** Leakage: raw {{placeholder}} text reached the user (page works, template didn't). */
const LEAK = '#9333ea';
const SEP = '\u0001';

/** Seconds for a grid cell: one decimal under 10 s. */
const secs = (ms: number) => (ms / 1000).toFixed(ms < 10_000 ? 1 : 0);
/** Speed class against the configured thresholds (amber / red; never a failure). */
const speedCls = (ms: number) => (ms >= config.loadVerySlowMs ? 'slow2' : ms >= config.loadSlowMs ? 'slow1' : 'fast');
/** "opened → shown 5.8 s: page arrived 0.6 s · app setup 4.4 s (slowest: filters/regions 2.2 s) · server 0.3 s · …" */
function timingTip(s: {
  loadMs?: number;
  pageMs?: number;
  setupMs?: number;
  slowestSetupCall?: string;
  serverMs?: number;
  downloadMs?: number;
  drawMs?: number;
}): string {
  const part = (label: string, v?: number) => (v == null ? '' : `${label} ${(v / 1000).toFixed(1)} s`);
  const setup = part('app setup', s.setupMs);
  const parts = [
    part('page arrived', s.pageMs),
    setup && s.slowestSetupCall ? `${setup} (slowest call: ${s.slowestSetupCall})` : setup,
    part('server', s.serverMs),
    part('download', s.downloadMs),
    part('drawing', s.drawMs),
  ].filter(Boolean);
  return `opened → shown ${s.loadMs == null ? 'never finished' : `${(s.loadMs / 1000).toFixed(1)} s`}${parts.length ? `: ${parts.join(' · ')}` : ''}`;
}
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.floor((a.length - 1) / 2)] : 0;
};

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
  const pfs: PlatformResultRow[] = readJsonl(join(dir, 'platform.jsonl'));
  const ons: OnScreenResultRow[] = readJsonl(join(dir, 'onscreen.jsonl'));
  const fls: FilterResultRow[] = readJsonl(join(dir, 'filters.jsonl'));
  if (comps.length === 0 && summary.length === 0 && pfs.length === 0) return;

  // The defect list: one row per problem, with a severity (src/defects.ts).
  const defects = buildDefects({ summary, comps, dls, fbs, pfs, onscreen: ons, filters: fls }, dir);
  const defectsCsv = writeDefectsCsv(dir, defects);
  const sevCount = (s: Severity) => defects.filter((d) => d.severity === s).length;
  const defectsHtml = `
      <details class="block defects" open>
        <summary><h2>Defect list</h2> ${
          defects.length === 0
            ? '<span class="good">no problems found ✓</span></summary>'
            : `<span class="sum">${defects.length} problem${defects.length === 1 ? '' : 's'}: <span class="sev High">${sevCount('High')} High</span> <span class="sev Medium">${sevCount('Medium')} Medium</span> <span class="sev Low">${sevCount('Low')} Low</span></span></summary>
        <p class="meta">One row per problem, not per filter combination · hover a problem for the expected result, “seen in” for the filters
          · saved as <a href="defects.csv">defects.csv</a> (opens in Excel; Jira can import it)</p>
        <div class="dwrap"><table class="dtable"><thead><tr><th>ID</th><th>Severity</th><th>Report</th><th>Component</th><th>Problem</th><th>What was seen</th><th>Seen in</th><th>Links</th></tr></thead><tbody>${defects
          .map(
            (d) =>
              `<tr><td class="did">${d.id}</td><td><span class="sev ${d.severity}">${d.severity}</span></td><td class="drep" title="${esc(d.reportId)}">${esc(d.reportId.split('/').pop())}</td><td class="dcomp">${d.section ? `<span class="bk-sec">${esc(d.section)}</span><br>` : ''}${esc(d.component)}</td><td class="dprob" title="Expected: ${esc(d.expected)}">${esc(d.problem)}</td><td class="dact">${esc(d.actual)}</td><td class="dseen" title="${esc(d.filters)}">${esc(d.seenIn)}</td><td class="dlinks">${d.reproduce ? `<a href="${esc(d.reproduce)}" target="_blank" rel="noopener">open</a>` : ''}${pictureLinks(d.evidence)}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
        }
      </details>`;

  // On-screen warnings, counted once per report × component × rule.
  const onScreenGroups = new Set(ons.map((o) => `${o.reportId}${SEP}${keyOf(o)}${SEP}${o.rule}`)).size;
  const RULE_NAME: Record<string, string> = {
    'junk-text': 'broken text',
    'over-100-percent': 'over 100%',
    'negative-number': 'negative number',
  };

  // Platform checks (same code on every report, run once): a plain table at the top.
  const pfIcon = (s: string) => (s === 'pass' ? '✓ pass' : s === 'warn' ? '⚠ warning' : '✗ fail');
  const pfPass = pfs.filter((p) => p.status === 'pass').length;
  const platformHtml = pfs.length
    ? `
      <details class="block platform" open>
        <summary><h2>Platform checks</h2> <span class="sum ${pfPass === pfs.length ? 'good' : 'bad'}">${pfPass}/${pfs.length} pass</span></summary>
        <p class="meta">The same on every report, so checked once per run, on ${esc(pfs[0].setup)}</p>
        <table class="ptable"><thead><tr><th>Test</th><th>What was found</th><th>Result</th></tr></thead><tbody>${pfs
          .map(
            (p) =>
              `<tr><td class="pt">${esc(p.area)} · ${esc(p.check)}</td><td>${esc(p.found)}</td><td class="pr ${esc(p.status)}">${pfIcon(p.status)}</td></tr>`,
          )
          .join('')}</tbody></table>
      </details>`
    : '';

  // Reports in run order; one whose page never loaded may have summary rows only.
  const byReport = new Map<string, ComponentResultRow[]>();
  for (const s of summary) if (!byReport.has(s.reportId)) byReport.set(s.reportId, []);
  for (const c of comps) {
    if (!byReport.has(c.reportId)) byReport.set(c.reportId, []);
    byReport.get(c.reportId)!.push(c);
  }

  // Up to 3 reports start open; a bigger run starts with every report folded to its one-line summary.
  const openReports = byReport.size <= 3;
  const reportSections: string[] = [];
  for (const [reportId, rows] of byReport) {
    // Columns in run order from the combo roll-ups, so a combo with no component
    // rows (page never loaded, aborted) still gets its column.
    const combos: string[] = [];
    for (const s of summary) if (s.reportId === reportId && !combos.includes(s.comboLabel)) combos.push(s.comboLabel);
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
    // On-screen warnings per cell (shown as "!" beside the dot).
    const ros = ons.filter((o) => o.reportId === reportId);
    const onMap = new Map<string, string>();
    for (const o of ros) {
      const k = `${keyOf(o)}${SEP}${o.comboLabel}`;
      const line = `On screen — ${RULE_NAME[o.rule] ?? o.rule}: ${o.detail}`;
      onMap.set(k, onMap.has(k) ? `${onMap.get(k)}\n${line}` : line);
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

    // Download status per component (checked once per report). Current runs record
    // one row per component (exact positional key); older runs only recorded the
    // controls clicked, matched to components by filename below.
    const rdl = dls.filter((d) => d.reportId === reportId);
    const rdlClicked = rdl.filter((d) => !d.state || d.state === 'ok' || d.state === 'failed');
    const rdlFailed = rdl.filter((d) => (d.state ? d.state === 'failed' : !d.ok));
    const rdlMissing = rdl.filter((d) => d.state === 'missing');
    const dlPerComponent = rdl.some((d) => d.sectionIndex != null);
    const dlByKey = new Map<string, DownloadResultRow[]>();
    for (const d of rdl) {
      if (d.sectionIndex == null || d.componentIndex == null) continue;
      const k = `i${d.sectionIndex}.${d.componentIndex}`;
      if (!dlByKey.has(k)) dlByKey.set(k, []);
      dlByKey.get(k)!.push(d);
    }
    const normTitle = (t: string) =>
      t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const DL_TYPES = ['table', 'table_advanced', 'bar', 'line', 'bar_line', 'pie', 'pyramid', 'waterfall'];
    const dlStatusFor = (key: string, title: string, type: string): { cls: string; text: string; tip: string } => {
      if (dlPerComponent) {
        const ds = dlByKey.get(key) ?? [];
        const bad = ds.filter((d) => d.state === 'failed');
        const good = ds.filter((d) => d.state === 'ok');
        const miss = ds.find((d) => d.state === 'missing');
        if (bad.length) return { cls: 'bad', text: '✗ failed', tip: bad.map((d) => `${d.kind.toUpperCase()}: ${d.error}`).join('; ') };
        if (good.length)
          return { cls: 'good', text: '✓ ok', tip: good.map((d) => `${d.kind.toUpperCase()}: ${d.filename} (${d.bytes} bytes)`).join('; ') };
        if (miss) return { cls: 'warnt', text: 'missing', tip: `no download button — ${miss.error}` };
        return { cls: 'na', text: '–', tip: ds[0]?.error || 'not checked' };
      }
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
      const s = comboSummary(c);
      const notLoaded = s?.pageLoaded === false;
      const retried = !notLoaded && (s?.navAttempts ?? 1) > 1;
      const note = notLoaded
        ? s?.navAttempts === 0
          ? ' — skipped: the site was unreachable for the combinations before it'
          : ' — page never loaded (tried twice)'
        : retried
          ? ' — page loaded only on the 2nd try (the first attempt got no page in time)'
          : '';
      thead += `<th class="combo" title="${esc(`Combination ${i + 1}: ${fullText(c)}${note}`)}"><span class="cl">Combo</span><span class="cn">${i + 1}${retried ? '<span class="rt">↻</span>' : ''}</span></th>`;
    });
    thead += '</tr></thead>';

    // Combo-status row: one dot per combo (its roll-up state from the summary),
    // so report-level breakage (e.g. leaked placeholders) shows red in the grid
    // even when every component cell underneath is green.
    let tbody = `<tbody><tr class="status-row"><td class="sec"></td><td class="comp">— combo status —</td><td class="dlcell"></td>${hasFb ? '<td class="fbcell"></td>' : ''}`;
    for (const combo of combos) {
      const s = comboSummary(combo);
      const color = s
        ? s.pageLoaded === false
          ? CELL.not_loaded
          : s.state === 'broken' && s.leakedPlaceholders
            ? LEAK
            : (CELL as Record<string, string>)[s.state] || 'transparent'
        : 'transparent';
      const title = s && s.state === 'broken' ? ` title="${esc(s.brokenComponents || 'broken')}"` : '';
      tbody += `<td class="cell"${title}><span class="dot" style="background:${color}"></span></td>`;
    }
    tbody += '</tr>';

    // Load-time rows, per combo: opened → shown, and the server time of the app's
    // one data request (≈ its slowest component's query). Hover for the breakdown.
    if (combosForReport.some((s) => s.loadMs != null || s.serverMs != null)) {
      const rowsOf: Array<[string, 'loadMs' | 'serverMs']> = [
        ['— load time (s) —', 'loadMs'],
        ['— server time (s) —', 'serverMs'],
      ];
      for (const [label, key] of rowsOf) {
        tbody += `<tr class="time-row"><td class="sec"></td><td class="comp">${label}</td><td class="dlcell"></td>${hasFb ? '<td class="fbcell"></td>' : ''}`;
        for (const combo of combos) {
          const s = comboSummary(combo);
          const v: number | undefined = s?.[key];
          tbody +=
            v == null
              ? `<td class="tcell na" title="${s?.pageLoaded === false ? 'not loaded' : 'not measured'}">–</td>`
              : `<td class="tcell ${speedCls(v)}" title="${esc(timingTip(s))}">${secs(v)}</td>`;
        }
        tbody += '</tr>';
      }
    }

    let lastSection = '';
    for (const ck of compKeys) {
      tbody += '<tr>';
      tbody += `<td class="sec">${ck.section !== lastSection ? esc(ck.section) : ''}</td>`;
      lastSection = ck.section;
      tbody += `<td class="comp" title="${esc(ck.component)}">${esc(ck.component)}</td>`;
      const firstRow = rows.find((r) => keyOf(r) === ck.key);
      const dstat = dlStatusFor(ck.key, ck.component, firstRow?.type || '');
      tbody += `<td class="dlcell ${dstat.cls}" title="${esc(dstat.tip)}">${dstat.text}</td>`;
      if (hasFb) {
        const fstat = fbStatusFor(ck.key);
        tbody += `<td class="fbcell ${fstat.cls}" title="${esc(fstat.tip)}">${fstat.text}</td>`;
      }
      for (const combo of combos) {
        const st = stateMap.get(`${ck.key}${SEP}${combo}`) || '';
        const err = errMap.get(`${ck.key}${SEP}${combo}`) || '';
        const color = (CELL as Record<string, string>)[st] || 'transparent';
        const title =
          st === 'broken' || st === 'not_loaded' ? ` title="${esc(err || 'Failed to load data')}"` : '';
        const os = onMap.get(`${ck.key}${SEP}${combo}`);
        tbody += `<td class="cell"${title}><span class="dot" style="background:${color}"></span>${
          os ? `<span class="osw" title="${esc(os)}">!</span>` : ''
        }</td>`;
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
    let keyHtml = `<details class="sub" open><summary class="key-title">Combination key — the filters each Combo column ran with</summary><table class="ckey"><thead><tr><th>Combination</th>${filterKeys
      .map((k) => `<th>${esc(k)}</th>`)
      .join('')}<th>Result</th><th>Load time</th></tr></thead><tbody>`;
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
      const notLoaded = s?.pageLoaded === false;
      const leak = st === 'broken' && s?.leakedPlaceholders;
      const color = notLoaded ? CELL.not_loaded : leak ? LEAK : (CELL as Record<string, string>)[st] || 'transparent';
      const label = notLoaded
        ? s?.navAttempts === 0
          ? 'not loaded — skipped, the site was unreachable'
          : 'not loaded — the page never loaded (tried twice)'
        : leak
          ? 'leakage'
          : st || 'not run';
      const nBroken = s ? Math.max(0, s.totalComponents - s.okCount - s.emptyCount) : 0;
      const counts = s && !notLoaded ? `${s.okCount} ok · ${s.emptyCount} empty · ${nBroken} broken` : '';
      const retried = !notLoaded && (s?.navAttempts ?? 1) > 1 ? ' <span class="rtn">· ↻ loaded on the 2nd try</span>' : '';
      const tip = st === 'broken' ? ` title="${esc(s?.brokenComponents || 'broken')}"` : '';
      const loadCell =
        s?.loadMs != null
          ? `<span class="${speedCls(s.loadMs)}">${(s.loadMs / 1000).toFixed(1)} s</span>${s.serverMs != null ? ` <span class="cnt">(server ${(s.serverMs / 1000).toFixed(1)} s)</span>` : ''}`
          : '–';
      keyHtml += `<td class="cres"${tip}><span class="dot" style="background:${color}"></span> ${esc(label)}${counts ? ` <span class="cnt">(${counts})</span>` : ''}${retried}</td><td class="ctime"${s?.loadMs != null ? ` title="${esc(timingTip(s))}"` : ''}>${loadCell}</td></tr>`;
    });
    keyHtml += `</tbody></table><p class="key-note"><b>bold</b> = set by this combination · plain grey = the app's own default (not chosen by the test) · — = filter not applied</p></details>`;

    const rc: Record<string, number> = { ok: 0, broken: 0, empty: 0, not_loaded: 0 };
    for (const r of rows) rc[r.state] = (rc[r.state] ?? 0) + 1;
    const retriedCombos = combosForReport.filter((s) => s.pageLoaded !== false && (s.navAttempts ?? 1) > 1).length;

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
      brokenHtml = listBlock(`⚠ Broken components (${byComp.size})`, '', items);
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
      brokenHtml += listBlock(`⬤ Leakage — raw {{placeholder}} shown to the user (${leakedList.length})`, 'leak', items);
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
      brokenHtml += listBlock(`⚠ Broken combos — report-level (${comboLevel.length})`, '', items);
    }

    // On-screen warnings, grouped by component and rule, with the combos they showed under.
    const onGroups = new Map<string, { o: OnScreenResultRow; combos: string[] }>();
    for (const o of ros) {
      const k = `${keyOf(o)}${SEP}${o.rule}`;
      if (!onGroups.has(k)) onGroups.set(k, { o, combos: [] });
      onGroups.get(k)!.combos.push(o.comboLabel);
    }
    if (onGroups.size > 0) {
      const items = [...onGroups.values()]
        .map(
          (g) =>
            `<li><div class="bk-head">${g.o.section ? `<span class="bk-sec">${esc(g.o.section)}</span> ` : ''}<b>${esc(g.o.component)}</b> <span class="bk-sec">(${esc(RULE_NAME[g.o.rule] ?? g.o.rule)})</span></div><div class="err">${esc(g.o.detail)}</div><div class="bk-combos">under: ${g.combos.map(comboRef).join(' ')}</div></li>`,
        )
        .join('');
      brokenHtml += listBlock(`⚑ On-screen checks (${onGroups.size})`, 'warnt', items);
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
      brokenHtml += listBlock(`☰ Standards warnings (${rst.length})`, 'std', items);
    }

    // Download details (per-component statuses are in the Downloads column):
    // failed downloads (red), then components with no download button (amber,
    // grouped by reason).
    const dlWhere = (d: DownloadResultRow) =>
      d.component
        ? `${d.section ? `<span class="bk-sec">${esc(d.section)}</span> ` : ''}<b>${esc(d.component)}</b>${d.type ? ` <span class="bk-sec">(${esc(d.type)})</span>` : ''}`
        : `<b>${esc(d.label)}</b>`;
    if (rdlFailed.length > 0) {
      const items = rdlFailed
        .map(
          (d2) =>
            `<li><div class="bk-head">${dlWhere(d2)}${d2.kind ? ` <span class="bk-sec">— ${esc(d2.kind.toUpperCase())} download</span>` : ''}</div><div class="err">${esc(d2.error || 'download failed')}</div></li>`,
        )
        .join('');
      brokenHtml += listBlock(`⬇ Failed downloads (${rdlFailed.length})`, '', items);
    }
    if (rdlMissing.length > 0) {
      const byReason = new Map<string, DownloadResultRow[]>();
      for (const d of rdlMissing) {
        if (!byReason.has(d.error)) byReason.set(d.error, []);
        byReason.get(d.error)!.push(d);
      }
      const items = [...byReason.entries()]
        .map(([reason, ds]) => `<li><div class="err">${esc(reason)}</div><div class="bk-combos">${ds.map(dlWhere).join(' · ')}</div></li>`)
        .join('');
      brokenHtml += listBlock(`⬇ Download button missing (${rdlMissing.length})`, 'warnt', items);
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
      brokenHtml += listBlock(`💬 Feedback form problems (${fbModalBroken.length})`, '', items);
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
      brokenHtml += listBlock(`💬 Feedback button missing (${fbMissing.length})`, 'warnt', items);
    }
    if (fbNotes.length > 0) {
      const items = fbNotes.map((f) => `<li><div class="bk-head">${where(f)}</div><div class="err">${esc(f.detail)}</div></li>`).join('');
      brokenHtml += listBlock(`💬 Feedback notes (${fbNotes.length})`, 'std', items);
    }

    const fbVisual = rfb.filter((f) => f.check === 'button' && f.scope === 'visual' && f.state !== 'na');
    const fbVisualOk = fbVisual.filter((f) => f.state === 'ok').length;
    const fbModals = rfb.filter((f) => f.check === 'modal');
    const fbMeta = hasFb
      ? ` · <span class="${fbModalBroken.length ? 'bad' : fbMissing.length ? 'warnt' : 'good'}">💬 ${fbVisualOk}/${fbVisual.length} components have Feedback · form ${fbModals.length - fbModalBroken.length}/${fbModals.length} ok</span>`
      : '';

    // Load-time summary for this report: fastest / typical / slowest, and where.
    const timed = combosForReport.filter((s) => s.loadMs != null);
    const serverTimes = combosForReport.filter((s) => s.serverMs != null).map((s) => s.serverMs as number);
    let timingMeta = '';
    if (timed.length > 0) {
      const byLoad = [...timed].sort((a, b) => a.loadMs - b.loadMs);
      const slow = byLoad[byLoad.length - 1];
      const f = (v: number) => `${(v / 1000).toFixed(1)} s`;
      const setupTimes = combosForReport.filter((s) => s.setupMs != null).map((s) => s.setupMs as number);
      // The call that was most often the slowest during app setup, e.g. "filters/regions".
      const setupCallCounts = new Map<string, number>();
      for (const s of combosForReport) {
        const name = (s.slowestSetupCall as string | undefined)?.replace(/ [\d.]+ s$/, '');
        if (name) setupCallCounts.set(name, (setupCallCounts.get(name) ?? 0) + 1);
      }
      const usualSlowCall = [...setupCallCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      timingMeta = `<p class="meta">⏱ Opened → shown: fastest <b>${f(byLoad[0].loadMs)}</b> · typical <b>${f(median(timed.map((s) => s.loadMs)))}</b> · slowest <b class="${speedCls(slow.loadMs)}">${f(slow.loadMs)}</b> under ${comboRef(slow.comboLabel)}${
        setupTimes.length
          ? ` · of which app setup typically <b>${f(median(setupTimes))}</b>${usualSlowCall ? ` (slowest call usually <code>${esc(usualSlowCall)}</code>)` : ''}`
          : ''
      }${
        serverTimes.length
          ? ` · data request (server): typical <b>${f(median(serverTimes))}</b>, slowest <b class="${speedCls(Math.max(...serverTimes))}">${f(Math.max(...serverTimes))}</b>`
          : ''
      }</p>`;
    }

    // How each filter's dropdown list loaded (hover for the values used / the error).
    const rfl = fls.filter((f) => f.reportId === reportId);
    const filtersMeta = rfl.length
      ? `<p class="meta">⚙ Filter lists: ${rfl
          .map((f) =>
            f.status === 'ok'
              ? `<span title="${esc(`${f.available} values · this run used: ${f.sampled}`)}">${esc(f.filter)} <span class="good">✓ ${f.available}</span></span>`
              : f.status === 'failed'
                ? `<span title="${esc(f.error)}">${esc(f.filter)} <span class="bad">✗ did not load</span></span>`
                : `<span title="${esc(f.error || 'the list had no values')}">${esc(f.filter)} <span class="${f.error ? 'muted' : 'warnt'}">— empty${f.error ? ` (${esc(f.error)})` : ''}</span></span>`,
          )
          .join(' · ')}</p>`
      : '';

    reportSections.push(`
      <details class="report"${openReports ? ' open' : ''}>
        <summary><h2>${esc(reportId)}</h2>
        <span class="meta sum">${combos.length} combos · ${compKeys.length} components ·
          <span class="good">${rc.ok} ok</span> / <span class="bad">${rc.broken} broken</span> / <span class="muted">${rc.empty} empty</span>${
            rc.not_loaded ? ` / <span class="nl">${rc.not_loaded} not loaded</span>` : ''
          } cells ·
          <span class="${brokenCombos ? 'bad' : 'good'}">${brokenCombos} broken combo(s)</span>${
            leakedList.length > 0 ? ` · <span class="chip leak">⬤ ${leakedList.length} leakage</span>` : ''
          }${
            comboLevel.length > 0 ? ` · <span class="chip warn">⚠ ${comboLevel.length} report-level</span>` : ''
          }${
            retriedCombos > 0 ? ` · <span class="chip nl" title="page loaded only on the 2nd try">↻ ${retriedCombos} retried</span>` : ''
          }${
            rdl.length > 0
              ? ` · <span class="${rdlFailed.length ? 'bad' : 'good'}">⬇ ${rdlClicked.length - rdlFailed.length}/${rdlClicked.length} downloads ok</span>${
                  rdlMissing.length ? ` · <span class="warnt">⬇ ${rdlMissing.length} without a download button</span>` : ''
                }`
              : ''
          }${fbMeta}${onGroups.size > 0 ? ` · <span class="chip warn">⚑ ${onGroups.size} on-screen</span>` : ''}${
            rst.length > 0 ? ` · <span class="chip std">☰ ${rst.length} standards</span>` : ''
          }</span></summary>
        ${timingMeta}
        ${filtersMeta}
        <div class="tablewrap"><table class="grid">${thead}${tbody}</table></div>
        ${keyHtml}
        ${brokenHtml}
      </details>`);
  }

  const totals: Record<string, number> = { ok: 0, broken: 0, empty: 0, not_loaded: 0 };
  for (const c of comps) totals[c.state] = (totals[c.state] ?? 0) + 1;
  const totalBrokenCombos = summary.filter((s) => s.state === 'broken').length;
  const notLoadedCombos = summary.filter((s) => s.pageLoaded === false).length;
  const allLoads = summary.filter((s) => s.loadMs != null).map((s) => s.loadMs as number);
  const allServer = summary.filter((s) => s.serverMs != null).map((s) => s.serverMs as number);
  const slowestRow = summary.filter((s) => s.loadMs != null).sort((a, b) => b.loadMs - a.loadMs)[0];
  const dlClickedAll = dls.filter((d) => !d.state || d.state === 'ok' || d.state === 'failed');
  const dlFailedAll = dls.filter((d) => (d.state ? d.state === 'failed' : !d.ok));
  const dlMissingAll = dls.filter((d) => d.state === 'missing');
  const retriedAll = summary.filter((s) => s.pageLoaded !== false && (s.navAttempts ?? 1) > 1).length;
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
  .nl{color:#b45309;font-weight:600}
  .rt{color:#b45309;font-weight:700;font-size:11px;margin-left:1px}
  .rtn{color:#b45309;font-size:11px;font-weight:600}
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
  .chip.nl{background:#fef3c7;color:#92400e}
  tr.time-row td{background:#fcfcfb}
  tr.time-row td.comp{font-size:11px;color:#6b7280;font-weight:600}
  td.tcell{font-size:10px;font-weight:700;text-align:center;padding:3px 0}
  .fast{color:#15803d}.slow1{color:#b45309}.slow2{color:#b91c1c}
  td.tcell.slow1{background:#fffbeb}td.tcell.slow2{background:#fef2f2}td.tcell.na{color:#9ca3af;font-weight:400}
  table.ckey td.ctime{white-space:nowrap}
  .platform{margin:18px 0 8px}
  table.ptable{border-collapse:collapse;font-size:13px;max-width:1300px}
  table.ptable th,table.ptable td{border:1px solid #e5e7eb;padding:7px 12px;text-align:left;vertical-align:top}
  table.ptable th{background:#f9fafb;font-weight:700}
  table.ptable td.pt{white-space:nowrap;font-weight:600;color:#111}
  table.ptable td.pr{white-space:nowrap;font-weight:700}
  td.pr.pass{color:#15803d}
  td.pr.fail{color:#b91c1c}
  td.pr.warn{color:#b45309}
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
  .osw{display:inline-block;margin-left:2px;font-size:11px;font-weight:800;color:#b45309;vertical-align:1px;cursor:help}
  /* Collapsible sections: ▸ closed, ▾ open */
  details>summary{cursor:pointer;list-style:none}
  details>summary::-webkit-details-marker{display:none}
  details>summary::before{content:'▸';display:inline-block;width:16px;color:#374151;font-size:15px;line-height:1;transition:transform .12s}
  details[open]>summary::before{transform:rotate(90deg)}
  details.block,details.report{margin:22px 0 0;border-top:1px solid #e5e7eb;padding-top:8px}
  details.block>summary h2,details.report>summary h2{display:inline;margin:0}
  details.block>summary .sum{font-size:13px;margin-left:8px}
  details.report>summary .sum{display:block;margin:4px 0 8px 14px}
  details.sub>summary{margin:14px 0 6px}
  .tools{margin:2px 0 6px}
  .tools button{font:inherit;font-size:12px;padding:3px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;margin-right:6px}
  .tools button:hover{background:#f3f4f6}
  .defects{margin:18px 0 8px}
  .dwrap{overflow:auto;max-height:62vh;border:1px solid #e5e7eb;border-radius:8px;max-width:1500px}
  table.dtable{border-collapse:collapse;font-size:12px;width:100%}
  table.dtable th,table.dtable td{border-bottom:1px solid #eee;padding:6px 10px;text-align:left;vertical-align:top}
  table.dtable thead th{position:sticky;top:0;z-index:1;background:#f9fafb;font-weight:700;border-bottom:2px solid #d1d5db}
  td.did{font-family:ui-monospace,monospace;white-space:nowrap;color:#374151}
  td.drep,td.dseen{white-space:nowrap}
  td.dlinks{min-width:120px;max-width:200px}
  td.dseen{cursor:help}
  td.dcomp{min-width:170px;max-width:300px}
  td.dprob{font-weight:600;white-space:nowrap;cursor:help}
  td.dact{min-width:260px;max-width:560px;color:#374151;word-break:break-word}
  .sev{display:inline-block;padding:1px 8px;border-radius:10px;font-weight:700;font-size:11px}
  .sev.High{background:#fee2e2;color:#991b1b}
  .sev.Medium{background:#fef3c7;color:#92400e}
  .sev.Low{background:#e0e7ff;color:#3730a3}
</style></head><body>
  <h1>Report functional audit — component × filter grid</h1>
  <p class="legend">Generated ${esc(new Date().toLocaleString())} ·
    <span class="dot" style="background:${CELL.ok}"></span>ok
    <span class="dot" style="background:${CELL.broken}"></span>broken
    <span class="dot" style="background:${CELL.empty}"></span>empty
    <span class="dot" style="background:${LEAK}"></span>leakage
    <span class="dot" style="background:${CELL.not_loaded}"></span>component not loaded (the page never loaded, even on a retry)
    <span class="dot" style="background:#fff;border:1px solid #d1d5db"></span>not checked
    · <span class="rt">↻</span> = page loaded only on the 2nd try
    · <span class="osw">!</span> = on-screen warning, e.g. a percentage over 100% (hover it)
    · columns are filter combinations (Combo 1…N) — each report's <b>Combination key</b> lists the exact filters
  </p>
  <p class="summary"><b>${comps.length}</b> component checks ·
    <span class="chip good">● ${totals.ok} ok</span>
    <span class="chip bad">● ${totals.broken} broken</span>
    <span class="chip muted">● ${totals.empty} empty</span>
    ${totals.not_loaded > 0 || notLoadedCombos > 0 ? `<span class="chip nl">● ${totals.not_loaded} not loaded (${notLoadedCombos} combo${notLoadedCombos === 1 ? '' : 's'})</span>` : ''}
    ${leakageCombos > 0 ? `<span class="chip leak">⬤ ${leakageCombos} leakage</span>` : ''}
    ${reportLevelBrokenCombos > 0 ? `<span class="chip warn">⚠ ${reportLevelBrokenCombos} report-level</span>` : ''}
    ${retriedAll > 0 ? `<span class="chip nl" title="page loaded only on the 2nd try">↻ ${retriedAll} retried</span>` : ''}
    ${pfs.length > 0 ? `<span class="chip ${pfPass === pfs.length ? 'good' : 'bad'}">▣ platform ${pfPass}/${pfs.length} pass</span>` : ''}
    ${
      allLoads.length > 0
        ? `<span class="chip ${speedCls(Math.max(...allLoads)) === 'fast' ? 'good' : speedCls(Math.max(...allLoads)) === 'slow1' ? 'warn' : 'bad'}" title="opened → shown; slowest: ${esc(slowestRow?.reportId ?? '')} — ${esc(slowestRow?.effective || slowestRow?.comboLabel || '')}">⏱ load typical ${(median(allLoads) / 1000).toFixed(1)} s · slowest ${(Math.max(...allLoads) / 1000).toFixed(1)} s</span>`
        : ''
    }
    ${dlClickedAll.length > 0 ? `<span class="chip ${dlFailedAll.length ? 'bad' : 'good'}">⬇ ${dlClickedAll.length - dlFailedAll.length}/${dlClickedAll.length} downloads ok</span>` : ''}
    ${dlMissingAll.length > 0 ? `<span class="chip warn">⬇ ${dlMissingAll.length} without a download button</span>` : ''}
    ${fbs.length > 0 ? `<span class="chip ${fbModalAllOk < fbModalAll.length ? 'bad' : fbVisualAllOk < fbVisualAll.length ? 'warn' : 'good'}">💬 ${fbVisualAllOk}/${fbVisualAll.length} with Feedback · form ${fbModalAllOk}/${fbModalAll.length} ok</span>` : ''}
    ${onScreenGroups > 0 ? `<span class="chip warn">⚑ ${onScreenGroups} on-screen warning${onScreenGroups === 1 ? '' : 's'}</span>` : ''}
    ${sts.length > 0 ? `<span class="chip std">☰ ${sts.length} standards</span>` : ''}
    ${
      defects.length > 0
        ? `<span class="chip ${sevCount('High') ? 'bad' : sevCount('Medium') ? 'warn' : 'std'}">◆ ${defects.length} defect${defects.length === 1 ? '' : 's'} (${sevCount('High')} High)</span>`
        : ''
    }
    · <span class="${totalBrokenCombos ? 'bad' : 'good'}">${totalBrokenCombos} of ${summary.length} combos broken</span></p>
  <p class="tools"><button type="button" onclick="document.querySelectorAll('details').forEach(function (d) { d.open = true; })">Expand all</button><button type="button" onclick="document.querySelectorAll('details').forEach(function (d) { d.open = false; })">Collapse all</button>${
    openReports ? '' : `<span class="meta">${byReport.size} reports — each starts folded to its summary; click one to open it.</span>`
  }</p>
  ${platformHtml}
  ${defectsHtml}
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
  if (pfs.length > 0) {
    console.log(`  ${pfPass === pfs.length ? col('32', '▣') : col('31', '▣')} platform: ${pfPass}/${pfs.length} check(s) pass`);
  }
  if (allLoads.length > 0) {
    const worst = Math.max(...allLoads);
    const c = speedCls(worst) === 'fast' ? '32' : speedCls(worst) === 'slow1' ? '33' : '31';
    console.log(
      `  ${col(c, '⏱')} load (opened → shown): typical ${(median(allLoads) / 1000).toFixed(1)} s · slowest ${(worst / 1000).toFixed(1)} s${
        slowestRow ? ` (${slowestRow.reportId.split('/').pop()} — ${slowestRow.comboLabel})` : ''
      }${allServer.length ? ` · server: typical ${(median(allServer) / 1000).toFixed(1)} s, slowest ${(Math.max(...allServer) / 1000).toFixed(1)} s` : ''}`,
    );
  }
  console.log(
    `  ${col('32', '●')} ${totals.ok} ok   ${col('31', '●')} ${totals.broken} broken   ${col('90', '●')} ${totals.empty} empty${
      totals.not_loaded > 0 ? `   ${col('33', '●')} ${totals.not_loaded} not loaded` : ''
    }${leakageCombos > 0 ? `   ${col('35', '●')} ${leakageCombos} leakage` : ''}`,
  );
  if (notLoadedCombos > 0 || retriedAll > 0) {
    console.log(
      `  ${col('33', '↻')} page load: ${retriedAll} combo(s) loaded only on the 2nd try · ${notLoadedCombos} never loaded`,
    );
  }
  console.log(
    `  ${totalBrokenCombos > 0 ? col('31', '✗') : col('32', '✓')} ${totalBrokenCombos} of ${summary.length} combo(s) broken${
      reportLevelBrokenCombos > 0 ? col('33', ` (${reportLevelBrokenCombos} report-level)`) : ''
    }`,
  );
  if (dls.length > 0) {
    const dlOk = dlClickedAll.length - dlFailedAll.length;
    console.log(
      `  ${dlFailedAll.length ? col('31', '⬇') : col('32', '⬇')} ${dlOk}/${dlClickedAll.length} download(s) ok${
        dlMissingAll.length ? col('33', ` · ${dlMissingAll.length} component(s) without a download button`) : ''
      }`,
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
  if (onScreenGroups > 0) {
    const byRule = (rule: string) => new Set(ons.filter((o) => o.rule === rule).map((o) => `${o.reportId}${SEP}${keyOf(o)}`)).size;
    const parts = Object.keys(RULE_NAME)
      .map((rule) => [byRule(rule), RULE_NAME[rule]] as const)
      .filter(([n]) => n > 0)
      .map(([n, name]) => `${n} ${name}`);
    console.log(`  ${col('33', '⚑')} on-screen: ${onScreenGroups} warning(s) — ${parts.join(' · ')}`);
  }
  const high = sevCount('High');
  console.log(
    `  ${col(high ? '31' : defects.length ? '33' : '32', '◆')} defects: ${high} high · ${sevCount('Medium')} medium · ${sevCount('Low')} low → ${defectsCsv}`,
  );
}
