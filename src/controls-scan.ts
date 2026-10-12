import type { Page } from '@playwright/test';
import { within } from './resilience';

/**
 * One read-only pass over the rendered report that maps every component's
 * header controls (Feedback button, download buttons) to the exact report
 * component they belong to. Shared by the feedback and download checks.
 *
 * Mapping trick: each visual Feedback button's click handler calls
 * window.openVisualFeedbackModal(sectionTitle, componentId, componentTitle)
 * with componentId = "<sectionId>::<componentIndex>". A recorder temporarily
 * patched over that global captures it — no modal opens — and the button's
 * `.component` block is then searched for download controls. In the app,
 * every download control sits in the same header as a Feedback button, so a
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
  cIdx: number; // JSON component index from the button's componentId; -1 if unparseable
  k: number; // n-th visual Feedback button within its section — re-locates the block later
  sectionTitle: string; // as the button passes it to the modal ('' on the subsection render path)
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
      const box: { v: { sectionTitle: string; componentId: string; componentTitle: string } | null } = { v: null };
      try {
        w.openVisualFeedbackModal = (sectionTitle: string, componentId: string, componentTitle: string) => {
          box.v = { sectionTitle, componentId, componentTitle };
        };
        const sections = Array.from(document.querySelectorAll(sectionsSel));
        sections.forEach((sec, si) => {
          sectionButtonCount.push(sec.querySelectorAll(sectionSel).length);
          sectionTitleShown.push((sec.querySelector('.section-header .section-title')?.textContent || '').trim());
          lazyLeft.push(sec.querySelectorAll('.chart-placeholder').length);
          Array.from(sec.querySelectorAll(visualSel)).forEach((b, k) => {
            box.v = null;
            (b as HTMLElement).click(); // handler calls the recorder above; no modal opens
            const got = box.v as { sectionTitle: string; componentId: string; componentTitle: string } | null;
            const idx = got ? parseInt(String(got.componentId).split('::').pop() || '', 10) : NaN;
            const block = b.closest('.component');
            if (block) blocks.push(block);
            components.push({
              sIdx: si,
              cIdx: Number.isFinite(idx) ? idx : -1,
              k,
              sectionTitle: got ? got.sectionTitle : '',
              componentTitle: got ? got.componentTitle : '',
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
