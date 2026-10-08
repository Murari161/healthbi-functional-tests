import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runDir } from './config';
import type { ComponentResultRow, ResultRow } from './types';

/**
 * Incremental results writer. Each report appends its rows as it finishes, so a
 * long sweep shows live progress and a crash never loses completed work. All
 * files go into this run's own folder (results/<run-id>), so a new run never
 * clobbers output you still have open (e.g. summary.csv in Excel).
 */

function outPaths() {
  const dir = runDir();
  return {
    dir,
    CSV: join(dir, 'summary.csv'),
    JSONL: join(dir, 'summary.jsonl'),
    COMP_CSV: join(dir, 'components.csv'),
    COMP_JSONL: join(dir, 'components.jsonl'),
  };
}

const HEADER = [
  'timestamp',
  'reportId',
  'comboLabel',
  'varies',
  'state',
  'totalComponents',
  'okCount',
  'emptyCount',
  'brokenComponents',
  'leakedPlaceholders',
  'url',
  'screenshot',
].join(',');

function csvCell(v: string | number | boolean): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COMP_HEADER = [
  'timestamp',
  'reportId',
  'comboLabel',
  'varies',
  'section',
  'component',
  'type',
  'state',
  'error',
  'sectionIndex',
  'componentIndex',
].join(',');

/**
 * (Re)create the output files with headers. Call ONCE per run, from globalSetup —
 * NOT from a per-worker beforeAll, which Playwright re-runs on every worker
 * restart (e.g. after a heavy report times out), wiping earlier reports' rows.
 */
export function initSummary(): void {
  const { dir, CSV, JSONL, COMP_CSV, COMP_JSONL } = outPaths();
  mkdirSync(dir, { recursive: true });
  writeFileSync(CSV, HEADER + '\n', 'utf8');
  writeFileSync(JSONL, '', 'utf8');
  writeFileSync(COMP_CSV, COMP_HEADER + '\n', 'utf8');
  writeFileSync(COMP_JSONL, '', 'utf8');
}

/** Create a single file with its header only if missing — never wipes, never touches others. */
function ensureFile(path: string, header: string): void {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, header, 'utf8');
  }
}

/** Append one result row (append-only; safe across worker restarts). */
export function appendResult(row: ResultRow): void {
  const { CSV, JSONL } = outPaths();
  ensureFile(CSV, HEADER + '\n');
  ensureFile(JSONL, '');
  const line = [
    row.timestamp,
    row.reportId,
    row.comboLabel,
    row.varies,
    row.state,
    row.totalComponents,
    row.okCount,
    row.emptyCount,
    row.brokenComponents,
    row.leakedPlaceholders,
    row.url,
    row.screenshot,
  ]
    .map(csvCell)
    .join(',');
  appendFileSync(CSV, line + '\n', 'utf8');
  appendFileSync(JSONL, JSON.stringify(row) + '\n', 'utf8');
}

/** Append one component-level result row (append-only; safe across worker restarts). */
export function appendComponentResult(row: ComponentResultRow): void {
  const { COMP_CSV, COMP_JSONL } = outPaths();
  ensureFile(COMP_CSV, COMP_HEADER + '\n');
  ensureFile(COMP_JSONL, '');
  const line = [
    row.timestamp,
    row.reportId,
    row.comboLabel,
    row.varies,
    row.section,
    row.component,
    row.type,
    row.state,
    row.error,
    row.sectionIndex ?? '',
    row.componentIndex ?? '',
  ]
    .map(csvCell)
    .join(',');
  appendFileSync(COMP_CSV, line + '\n', 'utf8');
  appendFileSync(COMP_JSONL, JSON.stringify(row) + '\n', 'utf8');
}

/** Safe filename fragment from a report id + combo label. */
export function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 120);
}
