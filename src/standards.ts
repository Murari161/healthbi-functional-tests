/** One design-standards warning for a component. */
export interface StandardsIssue {
  sIdx: number;
  cIdx: number;
  section: string;
  component: string;
  type: string;
  rule: string;
  detail: string;
}

const AXIS_CHART_TYPES = new Set(['bar', 'line', 'bar_line']);

/**
 * Design-standards warnings derived from the same report JSON the browser
 * renders. These are WARNINGS, not failures: they flag deviations from house
 * style (e.g. an unlabeled axis on a bar chart), not functional breakage.
 * Standards don't vary by filter, so run once per report (baseline combo).
 *
 * Rules:
 *  - axis-labels: bar / line / bar_line charts should declare axis titles
 *    (axisLabels.x and .y; y1 too for bar_line). Components that deliberately
 *    hide axes/titles (hideAxes, showAxisTitles:false, showValues) are skipped.
 */
export function standardsFromReport(rep: any): StandardsIssue[] {
  const issues: StandardsIssue[] = [];
  const sections = rep?.sections ?? [];
  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const s = sections[sIdx] ?? {};
    const comps = s.components ?? [];
    for (let cIdx = 0; cIdx < comps.length; cIdx++) {
      const comp = comps[cIdx] ?? {};
      if (!AXIS_CHART_TYPES.has(comp.type)) continue;
      if (comp.hideAxes === true || comp.showAxisTitles === false || comp.showValues === true) continue;
      const labels = comp.axisLabels ?? comp.data?.axisLabels ?? {};
      const missing: string[] = [];
      if (!String(labels.x ?? '').trim()) missing.push('x');
      if (!String(labels.y ?? '').trim()) missing.push('y');
      if (comp.type === 'bar_line' && !String(labels.y1 ?? '').trim()) missing.push('y1 (right)');
      if (missing.length > 0) {
        issues.push({
          sIdx,
          cIdx,
          section: s.title || s.id || '',
          component: comp.title || comp.type || '(untitled)',
          type: comp.type,
          rule: 'axis-labels',
          detail: `missing axis label(s): ${missing.join(', ')}`,
        });
      }
    }
  }
  return issues;
}
