import { existsSync, readFileSync } from 'node:fs';
import { config } from './config';
import type { ReportListItem } from './types';

/** Every report a normal user can see: the cached list from prepare-run. */
export function allReports(): ReportListItem[] {
  if (!existsSync(config.reportsCachePath)) {
    throw new Error(
      `Missing ${config.reportsCachePath}. Run \`npm run prepare-run\` first ` +
        `(or just \`npm run qa\`, which runs it for you).`,
    );
  }
  return JSON.parse(readFileSync(config.reportsCachePath, 'utf8'));
}

/** The reports this run covers: the cached list, narrowed by REPORT_SCOPE. */
export function loadReports(): ReportListItem[] {
  const all = allReports();
  if (config.scope === 'all') return all;
  const wanted = new Set(config.scope.split(',').map((s) => s.trim()).filter(Boolean));
  return all.filter((r) => wanted.has(r.id));
}
