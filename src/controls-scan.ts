import type { Page } from '@playwright/test';
import type { ComponentRow } from './components';
import { within } from './resilience';

/**
 * One read-only pass over the rendered report that maps every component's
 * header controls (Feedback button, download buttons) to the exact report
 * component they belong to. Shared by the feedback and download checks.
 *
 * Mapping trick: each visual Feedback button's click handler calls
 * window.openVisualFeedbackModal(...) with the component's identity. A recorder
 * temporarily patched over that global captures the arguments — no modal opens
 * — and the button's `.component` block is then searched for download
 * controls. Two argument shapes exist:
 *   - since the Oct 2026 deploy: (sectionTitle, componentId, componentTitle,
 *     sectionId, subsectionId), componentId = the config's id ("comp-84cc1291");
 *   - before: (sectionTitle, "<sectionId>::<index>", componentTitle).
 * Screen order is NOT report order when a section has subsections, so matching
 * is by id first, then the legacy index, then title (see matchComponents).
 * Every download control sits in the same header as a Feedback button, so a
 * component with no Feedback button has no download control either; anything
 * found outside a mapped block is counted as an orphan.
 */

export const SECTIONS = '#sections-container > .section';
/** Visual-scope Feedback buttons (the chart PNG button reuses the class — exclude it). */
export const VISUAL_FEEDBACK_BTN = '.component-feedback-btn:not(.component-download-btn)';
export const SECTION_FEEDBACK_BTN = '.section-feedback-btn';
export const REPORT_FEEDBACK_BTN = '#feedback-btn';
/** Table CSV export buttons. */
export const CSV_BTN = '.table-export-btn, [data-tooltip="Download as CSV"]';
/** Hover-revealed chart image buttons. */
export const PNG_BTN = '.component-download-btn';
/** The nearest `.component` ancestor of a header control (the block whose hover reveals it). */
export const OWNER_COMPONENT = `xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' component ')][1]`;

/** Types the app renders lazily (a `.chart-placeholder` until scrolled into view). */
export const LAZY_TYPES = new Set(['line', 'bar', 'pie', 'bar_line', 'choropleth', 'pyramid', 'waterfall']);

export interface MappedComponent {
  sIdx: number; // section, DOM order == report JSON order (the app renders every section, in order)
  k: number; // n-th visual Feedback button within its section — re-locates the block later
  componentId: string; // as the button passes it: the config id, or legacy "<sectionId>::<index>"
  cIdx: number; // JSON component index when componentId is the legacy form; else -1
  sectionId: string; // passed by the button since the Oct 2026 deploy ('' before)
  sectionTitle: string; // as the button passes it to the modal
  componentTitle: string;
  csv: number; // CSV download controls inside this component's block
  png: number; // chart-image download controls inside the block
}

export interface ControlsScan {
  components: MappedComponent[];
  sectionButtonCount: number[]; // section Feedback buttons, per rendered section
  sectionTitleShown: string[]; // on-screen section title ('' = untitled)
  lazyLeft: number[]; // unrendered lazy-chart placeholders, per section
  reportButtonVisible: boolean;
  orphanCsv: number; // download controls outside any mapped component block
  orphanPng: number;
}

export async function scanControls(page: Page): Promise<ControlsScan> {
  const scan = await within(scanPage(page), 20_000, null);
  if (!scan) throw new Error('page unresponsive — controls scan timed out (20s)');
  return scan;
}

function scanPage(page: Page): Promise<ControlsScan> {
  return page.evaluate(
    ({ sectionsSel, visualSel, sectionSel, reportSel, csvSel, pngSel }) => {
      const w = window as any;
      const orig = w.openVisualFeedbackModal;
      const components: MappedComponent[] = [];
      const sectionButtonCount: number[] = [];
      const sectionTitleShown: string[] = [];
      const lazyLeft: number[] = [];
      const blocks: Element[] = [];
      const box: { args: unknown[] | null } = { args: null };
      const str = (v: unknown) => (v == null ? '' : String(v));
      try {
        w.openVisualFeedbackModal = (...args: unknown[]) => {
          box.args = args;
        };
        const sections = Array.from(document.querySelectorAll(sectionsSel));
        sections.forEach((sec, si) => {
          sectionButtonCount.push(sec.querySelectorAll(sectionSel).length);
          sectionTitleShown.push((sec.querySelector('.section-header .section-title')?.textContent || '').trim());
          lazyLeft.push(sec.querySelectorAll('.chart-placeholder').length);
          Array.from(sec.querySelectorAll(visualSel)).forEach((b, k) => {
            box.args = null;
            (b as HTMLElement).click(); // handler calls the recorder above; no modal opens
            const a = (box.args as unknown[] | null) ?? [];
            const componentId = str(a[1]);
            const legacy = componentId.match(/::(\d+)$/);
            const block = b.closest('.component');
            if (block) blocks.push(block);
            components.push({
              sIdx: si,
              k,
              componentId,
              cIdx: legacy ? parseInt(legacy[1], 10) : -1,
              sectionId: str(a[3]),
              sectionTitle: str(a[0]),
              componentTitle: str(a[2]),
              csv: block ? block.querySelectorAll(csvSel).length : 0,
              png: block ? block.querySelectorAll(pngSel).length : 0,
            });
          });
        });
      } finally {
        w.openVisualFeedbackModal = orig; // ALWAYS restore the real handler
      }
      const root = document.querySelector('#sections-container');
      const orphans = (sel: string) =>
        root ? Array.from(root.querySelectorAll(sel)).filter((el) => !blocks.some((bk) => bk.contains(el))).length : 0;
      const rb = document.querySelector(reportSel) as HTMLElement | null;
      return {
        components,
        sectionButtonCount,
        sectionTitleShown,
        lazyLeft,
        reportButtonVisible: !!rb && rb.style.display !== 'none' && rb.offsetParent !== null,
        orphanCsv: orphans(csvSel),
        orphanPng: orphans(pngSel),
      };
    },
    {
      sectionsSel: SECTIONS,
      visualSel: VISUAL_FEEDBACK_BTN,
      sectionSel: SECTION_FEEDBACK_BTN,
      reportSel: REPORT_FEEDBACK_BTN,
      csvSel: CSV_BTN,
      pngSel: PNG_BTN,
    },
  );
}

/** Key of a report component in the maps below (its JSON position). */
export const compKey = (c: Pick<ComponentRow, 'sIdx' | 'cIdx'>) => `${c.sIdx}.${c.cIdx}`;

/**
 * Pair each on-screen component (from the scan) with its report component.
 * Exact by the config's component id when the button passes one; else by the
 * legacy "<sectionId>::<index>"; else by title within the same section, in
 * order. Returns report-component key → its on-screen component.
 */
export function matchComponents(comps: ComponentRow[], scan: ControlsScan): Map<string, MappedComponent> {
  const out = new Map<string, MappedComponent>();
  const taken = new Set<MappedComponent>();
  const claim = (c: ComponentRow, m: MappedComponent | undefined) => {
    if (!m || taken.has(m) || out.has(compKey(c))) return;
    out.set(compKey(c), m);
    taken.add(m);
  };
  const byId = new Map<string, MappedComponent>();
  for (const m of scan.components) if (m.componentId && m.cIdx < 0 && !byId.has(m.componentId)) byId.set(m.componentId, m);
  for (const c of comps) if (c.id) claim(c, byId.get(c.id));
  for (const c of comps) claim(c, scan.components.find((m) => !taken.has(m) && m.cIdx >= 0 && m.sIdx === c.sIdx && m.cIdx === c.cIdx));
  for (const c of comps) {
    if (out.has(compKey(c))) continue;
    const t = c.title.trim().toLowerCase();
    claim(c, scan.components.find((m) => !taken.has(m) && m.sIdx === c.sIdx && m.componentTitle.trim().toLowerCase() === t));
  }
  return out;
}
