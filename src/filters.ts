import type { APIRequestContext } from '@playwright/test';
import { config } from './config';
import type { FilterCombo, FilterDefinition } from './types';

/**
 * Discovers each report's filters dynamically (built-in AND custom) from the
 * report metadata, fetches real valid values from the same endpoints the UI
 * dropdowns use, and builds the filter matrix.
 *
 * NOTE: endpoint shapes/paths should be confirmed against the live site during
 * first setup (see README "Validate live"). The parsers below are deliberately
 * tolerant of common JSON shapes.
 */

interface FilterWithValues {
  def: FilterDefinition;
  values: string[];
}

const ORIGIN = new URL(config.apiBase).origin;

/** GET /api/report/<id> -> { filters: string[], filterDefinitions: {name: def} }. */
async function fetchReportMeta(
  request: APIRequestContext,
  reportId: string,
): Promise<{ order: string[]; defs: Record<string, FilterDefinition> }> {
  const res = await request.get(`${config.apiBase}/report/${encodeURIComponent(reportId)}`);
  if (!res.ok()) throw new Error(`report meta ${reportId}: HTTP ${res.status()}`);
  const body = await res.json();
  return {
    order: Array.isArray(body.filters) ? body.filters : [],
    defs: (body.filterDefinitions ?? {}) as Record<string, FilterDefinition>,
  };
}

/** Pull a flat list of string values out of whatever shape a filter endpoint returns. */
function extractValues(body: unknown): string[] {
  if (Array.isArray(body)) return body.map(String);
  if (body && typeof body === 'object') {
    // e.g. { districts: [...] } | { years: [...] } | { values: [...] } | { options: [...] }
    for (const v of Object.values(body as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        return v.map((item) =>
          item && typeof item === 'object'
            ? String((item as any).value ?? (item as any).id ?? (item as any).name ?? item)
            : String(item),
        );
      }
    }
  }
  return [];
}

/** Fetch valid values for one filter, injecting any parent params (cascades). */
async function fetchFilterValues(
  request: APIRequestContext,
  def: FilterDefinition,
  parentValues: Record<string, string>,
): Promise<string[]> {
  const url = new URL(def.apiEndpoint, ORIGIN);
  for (const p of def.parentParams ?? []) {
    if (parentValues[p]) url.searchParams.set(p, parentValues[p]);
  }
  try {
    const res = await request.get(url.toString());
    if (!res.ok()) return [];
    return extractValues(await res.json()).filter((v) => v && v !== 'null');
  } catch {
    return [];
  }
}

/** How many values to sample for a given filter, by its param name. */
function sampleCount(paramName: string): number {
  switch (paramName) {
    case 'year':
      return config.matrix.maxYears;
    case 'month':
    case 'quarter':
    case 'week':
      return config.matrix.maxMonths;
    case 'district':
    case 'region':
      return config.matrix.maxDistricts;
    case 'facility':
    case 'facility_select':
      return config.matrix.maxFacilities;
    default:
      return config.matrix.maxCustomValues;
  }
}

/** Resolve the report's filters and a sampled set of real values for each. */
export async function discoverFilters(
  request: APIRequestContext,
  reportId: string,
): Promise<FilterWithValues[]> {
  const { order, defs } = await fetchReportMeta(request, reportId);
  const resolved: FilterWithValues[] = [];
  const firstValueByParam: Record<string, string> = {};

  for (const name of order) {
    const def = defs[name];
    if (!def) continue;
    const values = await fetchFilterValues(request, def, firstValueByParam);
    const sampled = values.slice(0, sampleCount(def.paramName));
    if (sampled.length > 0) firstValueByParam[def.paramName] = sampled[0];
    resolved.push({ def, values: sampled });
  }
  return resolved;
}

/** Build the filter matrix from resolved filters, honoring MATRIX_MODE. */
export function buildMatrix(filters: FilterWithValues[]): FilterCombo[] {
  const combos: FilterCombo[] = [{ label: 'baseline', varies: 'baseline', params: {} }];
  const firstVal: Record<string, string> = {};
  for (const f of filters) if (f.values.length) firstVal[f.def.paramName] = f.values[0];

  if (config.matrix.mode === 'deep') {
    // Full factorial of sampled values (bounded by the MAX_* caps).
    let product: Record<string, string>[] = [{}];
    for (const f of filters) {
      const next: Record<string, string>[] = [];
      for (const base of product) {
        for (const v of f.values) next.push({ ...base, [f.def.paramName]: v });
      }
      product = next.length ? next : product;
    }
    for (const params of product) {
      if (Object.keys(params).length === 0) continue;
      combos.push({ label: describe(params), varies: 'combined', params });
    }
    return combos;
  }

  // Default: one-filter-at-a-time. Vary each filter alone; include parent
  // params so cascaded filters (e.g. facility within a district) stay valid.
  for (const f of filters) {
    for (const v of f.values) {
      const params: Record<string, string> = { [f.def.paramName]: v };
      for (const p of f.def.parentParams ?? []) {
        if (firstVal[p]) params[p] = firstVal[p];
      }
      combos.push({ label: `${f.def.paramName}=${v}`, varies: f.def.paramName, params });
    }
  }

  // A couple of realistic combined combos (period + location together).
  const combined: Record<string, string> = {};
  for (const key of ['year', 'month', 'district']) {
    if (firstVal[key]) combined[key] = firstVal[key];
  }
  if (Object.keys(combined).length >= 2) {
    combos.push({ label: describe(combined), varies: 'combined', params: combined });
  }
  return combos;
}

function describe(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(' & ');
}
