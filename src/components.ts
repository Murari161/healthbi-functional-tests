import type { Page } from '@playwright/test';
import { config } from './config';
import { authHeader } from './auth-capture';
import type { ComponentState } from './types';

/** Per-component result for one filter combo. */
export interface ComponentRow {
  /** Positional identity — stable across combos even when titles interpolate filters. */
  sIdx: number;
  cIdx: number;
  section: string;
  title: string;
  type: string;
  state: ComponentState;
  error: string;
}

/** Does a component's returned data actually contain anything to render? */
function hasData(comp: any): boolean {
  const d = comp?.data ?? {};
  if (Array.isArray(d.rows) && d.rows.length > 0) return true;
  if (Array.isArray(d.datasets) && d.datasets.some((ds: any) => Array.isArray(ds?.data) && ds.data.length > 0))
    return true;
  if (d.district_values && Object.keys(d.district_values).length > 0) return true;
  if (Array.isArray(d.facets) && d.facets.length > 0) return true;
  if (typeof comp?.content === 'string' && comp.content.trim()) return true; // text / kpi
  if (typeof comp?.infoboxBody === 'string' && comp.infoboxBody.trim()) return true;
  return false;
}

/**
 * Turn a report JSON (the same payload the browser fetches from
 * /api/report/<id>?filters to render the page) into per-component states. Each
 * component carries its own `error` (set when its query failed/timed out) and
 * `data`, so this is a faithful ok/empty/broken per component — the data that
 * produced what the user sees, not privileged backend access.
 */
/** First unsubstituted {{placeholder}} left in a component's text, if any. */
function leakedPlaceholder(comp: any): string {
  for (const field of [comp?.content, comp?.infoboxBody]) {
    if (typeof field === 'string') {
      const m = field.match(/\{\{[^}]+\}\}/);
      if (m) return m[0];
    }
  }
  return '';
}

export function componentStatesFromReport(rep: any): ComponentRow[] {
  const rows: ComponentRow[] = [];
  const sections = rep?.sections ?? [];
  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const s = sections[sIdx] ?? {};
    const sectionComps = s.components ?? [];
    for (let cIdx = 0; cIdx < sectionComps.length; cIdx++) {
      const comp = sectionComps[cIdx] ?? {};
      const leaked = leakedPlaceholder(comp);
      let state: ComponentState;
      let error = '';
      if (comp.error) {
        state = 'broken';
        error = String(comp.error).slice(0, 300);
      } else if (leaked) {
        // A placeholder the query never filled — the user sees literal {{…}}.
        state = 'broken';
        error = `leaked placeholder ${leaked} (alias not returned by the query)`;
      } else if (hasData(comp)) {
        state = 'ok';
      } else {
        state = 'empty';
      }
      rows.push({
        sIdx,
        cIdx,
        section: s.title || s.id || '',
        title: comp.title || comp.type || '(untitled)',
        type: comp.type || '',
        state,
        error,
      });
    }
  }
  return rows;
}

/**
 * Fallback: re-fetch the report JSON for a combo with the captured token, used
 * only when the browser's own response wasn't captured. Returns null on failure.
 */
export async function fetchReportJson(
  page: Page,
  token: string | null,
  reportId: string,
  params: Record<string, string>,
): Promise<any | null> {
  const qs = new URLSearchParams(params).toString();
  const url = `${config.apiBase}/report/${encodeURIComponent(reportId)}${qs ? `?${qs}` : ''}`;
  try {
    const res = await page.request.get(url, { headers: authHeader(token) });
    if (!res.ok()) return null;
    return await res.json();
  } catch {
    return null;
  }
}
