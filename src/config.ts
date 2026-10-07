import 'dotenv/config';

/**
 * Central configuration, read from environment (.env). See .env.example.
 * Everything that varies between environments or runs lives here so the
 * specs stay declarative.
 */

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * App base = origin + BASE_PATH (prod: https://dashboards.health.go.ug/report-browser).
 * The frontend builds API_BASE = BASE_PATH + '/api' (see public/js/app.js), so the
 * API base is the app base + '/api', NOT the bare origin + '/api'.
 */
const baseUrl = (process.env.HEALTHBI_BASE_URL ?? 'https://dashboards.health.go.ug/report-browser').replace(/\/$/, '');
const apiBase = (process.env.HEALTHBI_API_BASE ?? `${baseUrl}/api`).replace(/\/$/, '');

export const config = {
  /** Live report-browser app (origin + BASE_PATH), no trailing slash. */
  baseUrl,
  /** API base = baseUrl + '/api'. */
  apiBase,

  /** Credentials used only by scripts/prepare.ts for the one-time login. */
  user: process.env.HEALTHBI_USER ?? '',
  pass: process.env.HEALTHBI_PASS ?? '',

  /** Saved authenticated browser state, produced by prepare.ts. */
  storageStatePath: '.auth/user.json',
  /** Cached report list, produced by prepare.ts. */
  reportsCachePath: '.cache/reports.json',
  /** Where screenshots + CSV/JSON summaries land. */
  resultsDir: 'results',

  matrix: {
    mode: (process.env.MATRIX_MODE === 'deep' ? 'deep' : 'ofat') as 'ofat' | 'deep',
    maxYears: num('MAX_YEARS', 2),
    maxMonths: num('MAX_MONTHS', 2),
    maxDistricts: num('MAX_DISTRICTS', 2),
    maxFacilities: num('MAX_FACILITIES', 2),
    maxCustomValues: num('MAX_CUSTOM_VALUES', 2),
  },

  /** "all" or comma-separated report ids. */
  scope: process.env.REPORT_SCOPE ?? 'all',
};

/** Build a deep-link URL for a report + a filter combo (param -> value). */
export function reportUrl(reportId: string, combo: Record<string, string>): string {
  const params = new URLSearchParams({ report: reportId });
  for (const [k, v] of Object.entries(combo)) {
    if (v) params.set(k, v);
  }
  return `${config.baseUrl}/?${params.toString()}`;
}
