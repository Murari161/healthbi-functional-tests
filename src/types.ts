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

/** Load state of a single rendered component. */
export type ComponentState = 'ok' | 'empty' | 'broken';

/** Result of classifying one rendered report page. */
export interface ReportClassification {
  state: ComponentState; // worst-of across the page
  totalComponents: number;
  okCount: number;
  emptyCount: number;
  /** Titles of components that rendered an error card. */
  brokenComponents: string[];
  /** True if raw {{placeholder}} text leaked into the page. */
  leakedPlaceholders: boolean;
  /** True if the report shell never rendered at all. */
  neverRendered: boolean;
}

/** One row in the output summary. */
export interface ResultRow {
  timestamp: string;
  reportId: string;
  comboLabel: string;
  varies: string;
  state: ComponentState;
  totalComponents: number;
  okCount: number;
  emptyCount: number;
  brokenComponents: string;
  leakedPlaceholders: boolean;
  url: string;
  screenshot: string;
}
