/** A report as returned by GET /api/reports. */
export interface ReportListItem {
  id: string;
  title: string;
  category?: string;
  description?: string;
  keywords?: string;
}

/**
 * One filter's definition, as returned inside GET /api/report/<id>
 * under `filterDefinitions`. Mirrors the server's FilterDefinition.
 */
export interface FilterDefinition {
  type: string; // "select" | "multiselect"
  label: string;
  apiEndpoint: string; // fully-formed path, e.g. "/api/filters/districts?table=..."
  paramName: string; // URL query param the UI uses (e.g. "district")
  dependsOn?: string[];
  parentParams?: string[];
}

/** One point in the filter matrix: a label + the URL params to apply. */
export interface FilterCombo {
  /** Human label for the summary, e.g. "district=Kampala" or "baseline". */
  label: string;
  /** Which single filter this combo varies (OFAT), or "baseline"/"combined". */
  varies: string;
  /** param -> value map applied to the deep-link URL. */
  params: Record<string, string>;
}

/**
 * Load state of a single rendered component. 'not_loaded' = the report page
 * itself never arrived (even after a retry), so the user saw no component at all.
 */
export type ComponentState = 'ok' | 'empty' | 'broken' | 'not_loaded';

/** Result of classifying one rendered report page. */
export interface ReportClassification {
  state: ComponentState; // worst-of across the page
  totalComponents: number;
  okCount: number;
  emptyCount: number;
  /** Titles of components that rendered an error card. */
  brokenComponents: string[];
  /** The actual leaked {{alias}} strings found in the page (KPI-attributed where possible). */
  leakedSamples: string[];
  /** True if raw {{placeholder}} text leaked into the page. */
  leakedPlaceholders: boolean;
  /** True if the report shell never rendered at all. */
  neverRendered: boolean;
}

/** One row in the component-level output (per report × combo × component). */
export interface ComponentResultRow {
  timestamp: string;
  reportId: string;
  comboLabel: string;
  varies: string;
  /** Positional identity (section #, component #) — stable across combos even
   * when titles interpolate filter values. Optional for pre-existing run data. */
  sectionIndex?: number;
  componentIndex?: number;
  section: string;
  component: string;
  type: string;
  state: ComponentState;
  error: string;
}

/**
 * One row in the downloads output: per component × download control clicked, or
 * one row for a component with no download button ('missing') / not checkable ('na').
 */
export interface DownloadResultRow {
  timestamp: string;
  reportId: string;
  kind: 'csv' | 'png' | '';
  label: string;
  ok: boolean;
  filename: string;
  bytes: number;
  /** Failure message, or the reason a component is 'missing' / 'na'. */
  error: string;
  /** Absent on runs before per-component download checks (then: ok/failed only). */
  state?: 'ok' | 'failed' | 'missing' | 'na';
  section?: string;
  component?: string;
  type?: string;
  sectionIndex?: number;
  componentIndex?: number;
}

/** One row in the feedback output (per report, baseline combo; see src/feedback.ts). */
export interface FeedbackResultRow {
  timestamp: string;
  reportId: string;
  /** 'button' = control presence; 'modal' = open/verify/close exercise. */
  check: 'button' | 'modal';
  scope: 'report' | 'section' | 'visual';
  section: string;
  component: string;
  type: string;
  /** ok | missing (control absent) | broken (modal exercise failed) | na (error card). */
  state: 'ok' | 'missing' | 'broken' | 'na';
  detail: string;
  sectionIndex?: number;
  componentIndex?: number;
}

/** One platform-wide check (same code on every report, so run once per run). */
export interface PlatformCheck {
  /** Feature area, e.g. "Share". */
  area: string;
  /** What was tested, e.g. "Copy Link". */
  check: string;
  /** What was found, in words. */
  found: string;
  status: 'pass' | 'fail' | 'warn';
}

/** One row in the platform output. */
export interface PlatformResultRow extends PlatformCheck {
  timestamp: string;
  /** The report the check ran on. */
  reportId: string;
  /** The view it ran on, e.g. "TB Quarterly Report with region=Acholi, year=2027, quarter=1". */
  setup: string;
}

/** One row in the standards output (design warnings; never fail the test). */
export interface StandardsResultRow {
  timestamp: string;
  reportId: string;
  section: string;
  component: string;
  type: string;
  rule: string;
  detail: string;
}

/** One row in the output summary. */
export interface ResultRow {
  timestamp: string;
  reportId: string;
  comboLabel: string;
  varies: string;
  /** The full filter set the request actually ran with (app defaults included). */
  effective: string;
  state: ComponentState;
  totalComponents: number;
  okCount: number;
  emptyCount: number;
  brokenComponents: string;
  leakedPlaceholders: boolean;
  url: string;
  screenshot: string;
  /** Page-load attempts: 1 normally, 2 if the first got no page in time. Absent on older runs. */
  navAttempts?: number;
  /** False when the page never arrived, even on the retry. Absent on older runs. */
  pageLoaded?: boolean;
  /**
   * Load timing (ms), as the browser saw it: opened → report shown (no loading
   * placeholders), and its parts — page arrival; app setup (the app's own calls
   * before it asks for the data: sign-in check, report list, filter lists); the
   * app's one data request, split into server time (request sent → first byte
   * back, ≈ the slowest component's query, since the server runs them together)
   * and download; then drawing. Absent when unknown (page not loaded, older runs).
   */
  loadMs?: number;
  pageMs?: number;
  setupMs?: number;
  /** The slowest call during app setup, e.g. "filters/regions 2.2 s". */
  slowestSetupCall?: string;
  serverMs?: number;
  downloadMs?: number;
  drawMs?: number;
}
