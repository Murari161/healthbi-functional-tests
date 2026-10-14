import { existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { config, reportUrl } from './config';
import { slug } from './summary';
import type {
  ComponentResultRow,
  DownloadResultRow,
  FeedbackResultRow,
  FilterResultRow,
  OnScreenResultRow,
  PlatformResultRow,
  ResultRow,
} from './types';

/**
 * The defect list: every problem a run found, one row per distinct problem
 * (not one per filter combination), with a severity, what was seen, the
 * expected result, how often it showed up, a link that reproduces it and the
 * screenshot to attach. Built from the run's own result files after the run,
 * so `npm run report:html` rebuilds it for an earlier run too. Written as
 * defects.csv (opens in Excel; Jira can import it) and shown at the top of the
 * results page. Owner is left blank: assigning one is a person's call.
 */

export type Severity = 'High' | 'Medium' | 'Low';

type Kind =
  | 'component-failed'
  | 'placeholder-leak'
  | 'junk-text'
  | 'report-error'
  | 'page-not-loaded'
  | 'filter-failed'
  | 'no-data'
  | 'filter-empty'
  | 'over-100-percent'
  | 'negative-number'
  | 'very-slow'
  | 'feedback-form'
  | 'platform-fail'
  | 'check-aborted'
  | 'download-failed'
  | 'download-missing'
  | 'feedback-missing'
  | 'platform-warning';

/**
 * Severity per kind of problem. The QA team's scheme: errors and leakage are
 * High, no data is Medium, download and Feedback gaps are Low. Change it here.
 */
export const SEVERITY: Record<Kind, Severity> = {
  'component-failed': 'High', // a "Failed to load data" card
  'placeholder-leak': 'High', // raw {{placeholder}} text on screen
  'junk-text': 'High', // NaN / undefined / Infinity / null on screen
  'report-error': 'High', // the whole report failed: timeout box, fetch error, never shown
  'page-not-loaded': 'High', // the report page never arrived, even on a retry
  'filter-failed': 'High', // a filter's dropdown list failed to load (e.g. HTTP 500)
  'no-data': 'Medium', // empty in the default view, or in every combination tested
  'filter-empty': 'Medium', // a filter's dropdown list loaded with nothing to choose
  'over-100-percent': 'Medium',
  'negative-number': 'Medium',
  'very-slow': 'Medium', // took LOAD_VERY_SLOW_MS or more to show
  'feedback-form': 'Medium', // the Feedback button is there but its form misbehaves
  'platform-fail': 'Medium', // a Share-menu check failed (affects every report)
  'check-aborted': 'Medium', // the suite couldn't finish a view: look at it by hand
  'download-failed': 'Low',
  'download-missing': 'Low',
  'feedback-missing': 'Low',
  'platform-warning': 'Low',
};

const PROBLEM: Record<Kind, string> = {
  'component-failed': 'Failed to load data',
  'placeholder-leak': 'Placeholder text shown',
  'junk-text': 'Broken text shown',
  'report-error': 'Report did not show',
  'page-not-loaded': 'Report page did not load',
  'filter-failed': 'Filter list did not load',
  'no-data': 'No data shown',
  'filter-empty': 'Filter list is empty',
  'over-100-percent': 'Percentage over 100%',
  'negative-number': 'Negative number shown',
  'very-slow': 'Very slow to show',
  'feedback-form': 'Feedback form problem',
  'platform-fail': 'Share menu problem',
  'check-aborted': 'Could not be checked',
  'download-failed': 'Download does not work',
  'download-missing': 'No download button',
  'feedback-missing': 'No Feedback button',
  'platform-warning': 'Share menu warning',
};

const EXPECTED: Record<Kind, string> = {
  'component-failed': 'The component shows its data, or "No data available" when there is none.',
  'placeholder-leak': 'Titles and text show real values, never {{placeholder}} text.',
  'junk-text': 'Values show as numbers or words, never NaN, undefined, Infinity or null.',
  'report-error': 'The report opens and shows its components.',
  'page-not-loaded': `The report page opens within ${config.navTimeoutMs / 1000} s.`,
  'filter-failed': "The filter's dropdown lists its values to choose from.",
  'no-data': 'The component shows data, or says why there is none.',
  'filter-empty': "The filter's dropdown lists values to choose from.",
  'over-100-percent':
    'Percentages are between 0% and 100%, unless this indicator can truly exceed 100% (e.g. coverage against population estimates).',
  'negative-number': 'Counts and totals are zero or more.',
  'very-slow': `The report shows within ${config.loadVerySlowMs / 1000} s.`,
  'feedback-form': 'The Feedback form opens for the right item, loads previous feedback and closes.',
  'platform-fail': 'The check passes.',
  'check-aborted': 'The view can be checked. Open it with the link and look at it by hand.',
  'download-failed': 'Clicking the download button saves a non-empty file.',
  'download-missing': 'Every component has a download button.',
  'feedback-missing': 'Every component has a Feedback button.',
  'platform-warning': 'The check passes.',
};

/** What each platform (Share menu) check expects — mirrors the README's "Passes when". */
const PLATFORM_EXPECTED: Record<string, string> = {
  'Share button and menu': 'The Share menu opens with Download PDF, Save Offline, Copy Link, Email and WhatsApp.',
  Email: 'The pre-filled email has the report title and a link carrying every filter.',
  WhatsApp: 'The pre-filled message has the report title and a link carrying every filter.',
  'Save Offline': 'The option switches to "Remove Offline Copy" and back.',
  'Download PDF': 'The server builds a real, non-empty PDF.',
  'Copy Link': 'The copied link carries every filter.',
  'Share button after Copy Link': 'The Share button keeps its icon after "Copied!".',
  'Shared link opens the same view': 'The copied link opens the same report with the same filters.',
};

export interface Defect {
  id: string;
  severity: Severity;
  /** One line for a ticket title: "Problem — component (report)". */
  summary: string;
  reportId: string;
  section: string;
  component: string;
  problem: string;
  /** What was seen. */
  actual: string;
  expected: string;
  /** How often: "3 of 6 combinations", "default view", "once per run". */
  seenIn: string;
  /** The filters of the first view it was seen in. */
  filters: string;
  /** Deep link that opens that view. */
  reproduce: string;
  /** Screenshot path inside the run folder ('' when there is none). */
  evidence: string;
  /** Left blank for a person to assign. */
  owner: string;
}

export interface RunResults {
  summary: ResultRow[];
  comps: ComponentResultRow[];
  dls: DownloadResultRow[];
  fbs: FeedbackResultRow[];
  pfs: PlatformResultRow[];
  onscreen: OnScreenResultRow[];
  filters: FilterResultRow[];
}

interface Draft {
  kind: Kind;
  reportId: string;
  section: string;
  component: string;
  problem?: string;
  actual: string;
  expected?: string;
  seenIn: string;
  filters: string;
  reproduce: string;
  evidence: string;
  /** Sort keys: report position (-1 = platform) and component position (-1 = whole report). */
  reportOrder: number;
  order: number;
}

/** Same row identity as the grid: position when known, else section + title. */
function keyOf(r: { sectionIndex?: number; componentIndex?: number; section?: string; component?: string }): string {
  return r.sectionIndex != null && r.componentIndex != null ? `i${r.sectionIndex}.${r.componentIndex}` : `${r.section}\u0001${r.component}`;
}
const orderOf = (r: { sectionIndex?: number; componentIndex?: number }) =>
  r.sectionIndex != null && r.componentIndex != null ? r.sectionIndex * 1000 + r.componentIndex : 999_999;

/** "facility=X & year=2027" → ["facility", "year"] (splits only on " & " followed by "name="). */
const paramsOf = (label: string): string[] =>
  !label || label === 'baseline' ? [] : label.split(/ & (?=[A-Za-z_][\w.-]*=)/).map((p) => p.slice(0, p.indexOf('=')));

/** "whenever facility is set" — when one filter is set in every view it failed in, and it failed in every view with that filter. */
function whenever(failing: string[], loaded: ResultRow[]): string {
  const fail = new Set(failing);
  for (const k of new Set(failing.flatMap(paramsOf))) {
    const withK = loaded.filter((s) => paramsOf(s.comboLabel).includes(k));
    if (failing.every((l) => paramsOf(l).includes(k)) && withK.every((s) => fail.has(s.comboLabel))) return `whenever ${k} is set`;
  }
  return '';
}

/** "A, B, C, D, E and 3 more" */
const names = (xs: string[]) => (xs.length <= 5 ? xs.join(', ') : `${xs.slice(0, 5).join(', ')} and ${xs.length - 5} more`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function buildDefects(r: RunResults, dir: string): Defect[] {
  const drafts: Draft[] = [];
  const rel = (p?: string) => (p ? relative(dir, p).replace(/\\/g, '/') : '');
  const reports: string[] = [];
  for (const s of r.summary) if (!reports.includes(s.reportId)) reports.push(s.reportId);
  for (const c of r.comps) if (!reports.includes(c.reportId)) reports.push(c.reportId);

  reports.forEach((reportId, reportOrder) => {
    const combos = r.summary.filter((s) => s.reportId === reportId);
    const loaded = combos.filter((s) => s.pageLoaded !== false);
    const combo = (label?: string) => combos.find((s) => s.comboLabel === label);
    const baseLabel = (loaded.find((s) => s.comboLabel === 'baseline') ?? loaded[0])?.comboLabel;
    /** The filters of a view, as the app ran it ("default view" for the baseline). */
    const where = (label?: string) => {
      const eff = combo(label)?.effective || '';
      return label === 'baseline' ? `default view${eff ? ` (${eff})` : ''}` : eff || label || '';
    };
    const seen = (n: number, of: number) => (of <= 1 ? 'the one view tested' : n >= of ? `all ${of} combinations` : `${n} of ${of} combinations`);
    const url = (label?: string) => combo(label)?.url || reportUrl(reportId, {});
    const shot = (label?: string) => rel(combo(label)?.screenshot);
    const at = (label?: string) => ({ filters: where(label), reproduce: url(label), evidence: shot(label) });
    const add = (kind: Kind, d: Omit<Draft, 'kind' | 'reportId' | 'reportOrder'>) => drafts.push({ kind, reportId, reportOrder, ...d });
    const rc = r.comps.filter((c) => c.reportId === reportId);

    // A filter whose dropdown list didn't load can't be used (or tested).
    for (const f of r.filters.filter((x) => x.reportId === reportId)) {
      if (f.status === 'ok' || (f.status === 'empty' && f.error)) continue; // empty because a parent filter has no value: expected
      add(f.status === 'failed' ? 'filter-failed' : 'filter-empty', {
        section: '',
        component: `${f.filter} filter`,
        actual:
          f.status === 'failed'
            ? `The ${f.filter} dropdown list did not load (${f.error}), so this filter could not be tested`
            : `The ${f.filter} dropdown list is empty, so this filter could not be tested`,
        seenIn: 'every view',
        ...at(baseLabel),
        evidence: '',
        order: -2,
      });
    }

    // Components that failed to load, or leaked a {{placeholder}} in their own text.
    const broken = new Map<string, { first: ComponentResultRow; combos: string[]; kind: Kind }>();
    for (const c of rc) {
      if (c.state !== 'broken') continue;
      const kind: Kind = c.error.startsWith('leaked placeholder') ? 'placeholder-leak' : 'component-failed';
      const k = `${keyOf(c)}|${kind}`;
      if (!broken.has(k)) broken.set(k, { first: c, combos: [], kind });
      broken.get(k)!.combos.push(c.comboLabel);
    }
    // Components failing with the same error in the same views share one cause:
    // one row (e.g. "21 components … whenever facility is set"), not one each.
    const causes = new Map<string, Array<{ first: ComponentResultRow; combos: string[]; kind: Kind }>>();
    for (const g of broken.values()) {
      const k = `${g.kind}|${g.first.error}|${[...g.combos].sort().join('\u0001')}`;
      if (!causes.has(k)) causes.set(k, []);
      causes.get(k)!.push(g);
    }
    for (const gs of causes.values()) {
      const { first: c, combos: failing, kind } = gs[0];
      const label = failing[0];
      const many = gs.length > 1;
      const when = whenever(failing, loaded);
      const list = many ? names(gs.map((g) => g.first.component)) : '';
      const sections = [...new Set(gs.map((g) => g.first.section))];
      const card = join(dir, 'screenshots', 'components', `${slug(reportId)}__${slug(label)}__${slug(c.component)}.png`);
      add(kind, {
        section: sections.length === 1 ? sections[0] : '',
        component: many ? `${gs.length} components` : c.component,
        actual:
          kind === 'component-failed'
            ? `${many ? `${gs.length} components show` : 'Shows'} "Failed to load data"${when ? ` ${when}` : ''}${many ? ` (${list})` : ''}${c.error ? ` — ${c.error}` : ''}`
            : `${c.error}${when ? `, ${when}` : ''}${many ? ` (${list})` : ''}`,
        seenIn: seen(failing.length, loaded.length),
        ...at(label),
        evidence: !many && existsSync(card) ? rel(card) : shot(label),
        order: many ? -1 : orderOf(c),
      });
    }

    // {{placeholder}} text found on the page itself (not already listed above).
    const listedTokens = new Set(rc.filter((c) => c.error.startsWith('leaked placeholder')).flatMap((c) => c.error.match(/\{\{[^}]+\}\}/g) ?? []));
    const leaks = new Map<string, string[]>();
    for (const s of combos) {
      const i = s.leakedPlaceholders ? s.brokenComponents.indexOf('leaked placeholder → ') : -1;
      if (i < 0) continue;
      const text = s.brokenComponents.slice(i + 'leaked placeholder → '.length).replace(/ \| \(report fetch failed\)$/, '');
      for (const sample of text.split(' | ')) {
        const tokens = sample.match(/\{\{[^}]+\}\}/g) ?? [];
        if (tokens.length > 0 && tokens.every((t) => listedTokens.has(t))) continue;
        if (!leaks.has(sample)) leaks.set(sample, []);
        leaks.get(sample)!.push(s.comboLabel);
      }
    }
    for (const [sample, labels] of leaks) {
      const titled = sample.match(/^(.+?): \{\{/);
      add('placeholder-leak', {
        section: '',
        component: titled ? titled[1] : '(text on the page)',
        actual: `The page shows ${titled ? sample.slice(titled[1].length + 2) : sample} as text`,
        seenIn: seen(labels.length, loaded.length),
        ...at(labels[0]),
        order: -1,
      });
    }

    // On-screen warnings: junk text, a percentage over 100%, a negative number.
    const flagged = new Map<string, { first: OnScreenResultRow; combos: string[] }>();
    for (const o of r.onscreen.filter((x) => x.reportId === reportId)) {
      const k = `${keyOf(o)}|${o.rule}`;
      if (!flagged.has(k)) flagged.set(k, { first: o, combos: [] });
      flagged.get(k)!.combos.push(o.comboLabel);
    }
    for (const g of flagged.values()) {
      add(g.first.rule, {
        section: g.first.section,
        component: g.first.component,
        actual: g.first.detail,
        seenIn: seen(g.combos.length, loaded.length),
        ...at(g.combos[0]),
        order: orderOf(g.first),
      });
    }

    // The whole report failed (timeout box, fetch error, never shown), or the suite couldn't finish a view.
    const compBrokenCombos = new Set(rc.filter((c) => c.state === 'broken').map((c) => c.comboLabel));
    const whole = new Map<string, { kind: Kind; msg: string; combos: string[] }>();
    for (const s of loaded) {
      if (s.state !== 'broken' || s.leakedPlaceholders || compBrokenCombos.has(s.comboLabel)) continue;
      const raw = s.brokenComponents || '';
      const kind: Kind = raw.startsWith('combo aborted') ? 'check-aborted' : 'report-error';
      const msg =
        kind === 'check-aborted'
          ? raw.replace(/^combo aborted:\s*/, 'The check stopped: ')
          : raw.replace(/^REPORT:\s*/, '').replace('(report fetch failed)', "the report's data could not be fetched") ||
            'The report never showed its sections';
      const k = `${kind}|${msg.slice(0, 80)}`;
      if (!whole.has(k)) whole.set(k, { kind, msg, combos: [] });
      whole.get(k)!.combos.push(s.comboLabel);
    }
    for (const g of whole.values()) {
      add(g.kind, { section: '', component: '(whole report)', actual: g.msg, seenIn: seen(g.combos.length, loaded.length), ...at(g.combos[0]), order: -1 });
    }

    // The report page never arrived, even on a retry.
    const notLoaded = combos.filter((s) => s.pageLoaded === false);
    if (notLoaded.length > 0) {
      add('page-not-loaded', {
        section: '',
        component: '(whole report)',
        actual: notLoaded[0].brokenComponents || 'The page never loaded',
        seenIn: seen(notLoaded.length, combos.length),
        filters: where(notLoaded[0].comboLabel),
        reproduce: notLoaded[0].url,
        evidence: '',
        order: -1,
      });
    }

    // No data: a component empty in every combination tested; or empty in the
    // default view (what users see first). When most of the report opens empty,
    // that's one report-level problem (usually: the default period has no data yet).
    const byComp = new Map<string, ComponentResultRow[]>();
    for (const c of rc) {
      const k = keyOf(c);
      if (!byComp.has(k)) byComp.set(k, []);
      byComp.get(k)!.push(c);
    }
    const emptyByDefault: ComponentResultRow[][] = [];
    for (const rows of byComp.values()) {
      const judged = rows.filter((c) => c.state === 'ok' || c.state === 'empty');
      const empties = judged.filter((c) => c.state === 'empty');
      if (judged.length >= 2 && empties.length === judged.length) {
        add('no-data', {
          section: rows[0].section,
          component: rows[0].component,
          actual: `No data in any of the ${judged.length} combinations tested`,
          expected: 'The component shows data for at least one of the periods and places tested, or says why there is none.',
          seenIn: seen(empties.length, loaded.length),
          ...at(baseLabel),
          order: orderOf(rows[0]),
        });
      } else if (baseLabel && rows.some((c) => c.comboLabel === baseLabel && c.state === 'empty')) {
        emptyByDefault.push(rows);
      }
    }
    if (emptyByDefault.length >= Math.max(3, Math.ceil(byComp.size / 2))) {
      add('no-data', {
        section: '',
        component: '(whole report)',
        actual: `Opens with no data in ${emptyByDefault.length} of ${byComp.size} components: ${names(emptyByDefault.map((rows) => rows[0].component))}`,
        expected: 'The report opens on a period that has data.',
        seenIn: 'default view',
        ...at(baseLabel),
        order: -1,
      });
    } else {
      for (const rows of emptyByDefault) {
        const others = rows.filter((c) => c.comboLabel !== baseLabel && (c.state === 'ok' || c.state === 'empty'));
        const withData = others.filter((c) => c.state === 'ok').length;
        add('no-data', {
          section: rows[0].section,
          component: rows[0].component,
          actual: `No data in the default view${others.length ? `; shows data in ${withData} of ${plural(others.length, 'other combination')}` : ''}`,
          expected: 'The component shows data in the default view (what users see first), or says why there is none.',
          seenIn: 'default view',
          ...at(baseLabel),
          order: orderOf(rows[0]),
        });
      }
    }

    // Very slow to show.
    const slow = combos.filter((s) => s.loadMs != null && s.loadMs >= config.loadVerySlowMs).sort((a, b) => b.loadMs! - a.loadMs!);
    if (slow.length > 0) {
      add('very-slow', {
        section: '',
        component: '(whole report)',
        actual: `Took ${(slow[0].loadMs! / 1000).toFixed(1)} s to show at worst; ${plural(slow.length, 'combination')} took ${config.loadVerySlowMs / 1000} s or more`,
        seenIn: seen(slow.length, loaded.length),
        ...at(slow[0].comboLabel),
        order: -1,
      });
    }

    // Downloads (checked once per report, on the default view).
    const rdl = r.dls.filter((d) => d.reportId === reportId);
    for (const d of rdl) {
      if (d.state ? d.state !== 'failed' : d.ok) continue;
      add('download-failed', {
        section: d.section ?? '',
        component: d.component || d.label,
        actual: `${d.kind ? `${d.kind.toUpperCase()} download: ` : ''}${d.error || 'no file arrived'}`,
        seenIn: 'default view',
        ...at(baseLabel),
        order: orderOf(d),
      });
    }
    const noDownload = new Map<string, DownloadResultRow[]>();
    for (const d of rdl.filter((x) => x.state === 'missing')) {
      const k = d.type || 'other';
      if (!noDownload.has(k)) noDownload.set(k, []);
      noDownload.get(k)!.push(d);
    }
    for (const [type, ds] of noDownload) {
      const one = ds.length === 1;
      add('download-missing', {
        section: one ? (ds[0].section ?? '') : '',
        component: one ? ds[0].component || type : `${ds.length} ${type} components`,
        actual: `${one ? 'No download button' : `No download button on: ${names(ds.map((d) => d.component || '?'))}`} (${ds[0].error})`,
        seenIn: 'default view',
        ...at(baseLabel),
        order: one ? orderOf(ds[0]) : 999_998,
      });
    }

    // Feedback (checked once per report, on the default view). The form is never submitted.
    const rfb = r.fbs.filter((f) => f.reportId === reportId);
    const fbWhere = (f: FeedbackResultRow) =>
      f.scope === 'report' ? '(report header)' : f.scope === 'section' ? `(section) ${f.section}` : f.component;
    for (const f of rfb.filter((x) => x.check === 'modal' && x.state === 'broken')) {
      add('feedback-form', { section: f.section, component: fbWhere(f), actual: f.detail, seenIn: 'default view', ...at(baseLabel), order: orderOf(f) });
    }
    const noFeedback = new Map<string, FeedbackResultRow[]>();
    for (const f of rfb.filter((x) => x.check === 'button' && x.state === 'missing')) {
      const k = `${f.scope}|${f.type || 'other'}`;
      if (!noFeedback.has(k)) noFeedback.set(k, []);
      noFeedback.get(k)!.push(f);
    }
    for (const fs of noFeedback.values()) {
      const one = fs.length === 1;
      const type = fs[0].type || (fs[0].scope === 'visual' ? 'other' : fs[0].scope);
      add('feedback-missing', {
        section: one ? fs[0].section : '',
        component: one ? fbWhere(fs[0]) : `${fs.length} ${type} components`,
        actual: `${one ? 'No Feedback button' : `No Feedback button on: ${names(fs.map(fbWhere))}`}${fs[0].detail ? ` (${fs[0].detail})` : ''}`,
        seenIn: 'default view',
        ...at(baseLabel),
        order: one ? orderOf(fs[0]) : 999_998,
      });
    }
  });

  // Platform checks (the same on every report; run once).
  for (const p of r.pfs) {
    if (p.status === 'pass') continue;
    drafts.push({
      kind: p.status === 'fail' ? 'platform-fail' : 'platform-warning',
      reportId: p.reportId,
      section: '',
      component: `(platform) ${p.area}`,
      problem: `${p.area}: ${p.check}`,
      actual: p.found,
      expected: PLATFORM_EXPECTED[p.check],
      seenIn: 'once per run (the same on every report)',
      filters: p.setup,
      reproduce: reportUrl(p.reportId, {}),
      evidence: '',
      reportOrder: -1,
      order: -1,
    });
  }

  const rank: Record<Severity, number> = { High: 0, Medium: 1, Low: 2 };
  const kinds = Object.keys(SEVERITY);
  return drafts
    .sort(
      (a, b) =>
        rank[SEVERITY[a.kind]] - rank[SEVERITY[b.kind]] ||
        a.reportOrder - b.reportOrder ||
        a.order - b.order ||
        kinds.indexOf(a.kind) - kinds.indexOf(b.kind),
    )
    .map((d, i) => {
      const problem = d.problem ?? PROBLEM[d.kind];
      const where = d.reportOrder < 0 ? 'platform' : d.reportId.split('/').pop() || d.reportId;
      const what = /^\((whole report|platform)/.test(d.component) ? '' : ` — ${d.component}`;
      return {
        id: `D-${String(i + 1).padStart(3, '0')}`,
        severity: SEVERITY[d.kind],
        summary: `${problem}${what} (${where})`,
        reportId: d.reportId,
        section: d.section,
        component: d.component,
        problem,
        actual: d.actual.charAt(0).toUpperCase() + d.actual.slice(1),
        expected: d.expected ?? EXPECTED[d.kind],
        seenIn: d.seenIn,
        filters: d.filters,
        reproduce: d.reproduce,
        evidence: d.evidence,
        owner: '',
      };
    });
}

const CSV_HEADER = [
  'ID',
  'Severity',
  'Summary',
  'Report',
  'Section',
  'Component',
  'Problem',
  'What was seen',
  'Expected result',
  'Seen in',
  'Filters',
  'Link to reproduce',
  'Evidence',
  'Owner',
];

/** Write defects.csv into the run folder (UTF-8 with BOM so Excel shows "·", "—" and "“" correctly). */
export function writeDefectsCsv(dir: string, defects: Defect[]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [
    CSV_HEADER,
    ...defects.map((d) => [
      d.id,
      d.severity,
      d.summary,
      d.reportId,
      d.section,
      d.component,
      d.problem,
      d.actual,
      d.expected,
      d.seenIn,
      d.filters,
      d.reproduce,
      d.evidence,
      d.owner,
    ]),
  ].map((row) => row.map(cell).join(','));
  const out = join(dir, 'defects.csv');
  writeFileSync(out, '﻿' + lines.join('\r\n') + '\r\n', 'utf8');
  return out;
}
