import type { Locator, Page } from '@playwright/test';
import type { ComponentRow } from './components';
import {
  LAZY_TYPES,
  OWNER_COMPONENT,
  REPORT_FEEDBACK_BTN,
  SECTIONS,
  SECTION_FEEDBACK_BTN,
  VISUAL_FEEDBACK_BTN,
  scanControls,
  type ControlsScan,
  type MappedComponent,
} from './controls-scan';
import { within } from './resilience';

/**
 * Feedback-feature audit (read-only). The app puts a "Feedback" control at
 * three scopes — report (#feedback-btn in the report header), section
 * (.section-feedback-btn) and visual (.component-feedback-btn in each
 * component header) — all opening one modal (#feedback-modal) whose open fires
 * GET /api/feedback/<id> for the "Previous feedback" list.
 *
 *   1. Presence — every component should carry its feedback button, mapped to
 *      its exact component by the shared controls scan (src/controls-scan.ts).
 *   2. Modal — opened ONCE per scope through the real control (hover, then a
 *      normal click — a covered button fails, as it would for a user): modal
 *      shows, crumbs carry the right scope, the reporter identity is prefilled,
 *      required fields + an enabled submit exist, the previous-feedback list
 *      loads, and the × closes it.
 *
 * NEVER submits — this suite is read-only against production. The only
 * request a modal open causes is the list GET the app itself fires.
 */

export interface FeedbackCheck {
  check: 'button' | 'modal';
  scope: 'report' | 'section' | 'visual';
  section: string;
  component: string;
  type: string;
  state: 'ok' | 'missing' | 'broken' | 'na';
  detail: string;
  sectionIndex?: number;
  componentIndex?: number;
}

const MODAL = '#feedback-modal';

/** Types whose renderer attaches a feedback button (components.js appendComponentTitleRow / renderTable). */
const TYPES_WITH_BUTTON = new Set([
  'infobox',
  'line',
  'bar',
  'pie',
  'bar_line',
  'pyramid',
  'waterfall',
  'choropleth',
  'map',
  'table',
  'table_advanced',
]);

const REQUIRED_FIELDS = [
  'feedback-type',
  'feedback-severity',
  'feedback-comment',
  'feedback-affects',
  'feedback-followup',
  'feedback-corrective',
  'feedback-submit',
];

/**
 * Open the modal through `trigger` (hover + normal click, like a user), verify
 * it, close it with the ×. Read-only: fills nothing, never clicks submit.
 */
async function exerciseModal(
  page: Page,
  trigger: () => Promise<void>,
  expect: { scopeLabel: '' | 'Section' | 'Visual'; value: string },
): Promise<{ ok: boolean; detail: string }> {
  const problems: string[] = [];
  try {
    await trigger();
    const modal = page.locator(MODAL);
    await modal.waitFor({ state: 'visible', timeout: 8_000 });

    // Scope crumbs: "Report: …" always, plus "Section: …" / "Visual: …" by scope.
    const crumbs = (await page.locator('#feedback-modal-report').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!/Report:/i.test(crumbs)) problems.push('modal does not say which report it is for');
    if (expect.scopeLabel) {
      if (!new RegExp(`${expect.scopeLabel}:`, 'i').test(crumbs))
        problems.push(`modal lost its ${expect.scopeLabel.toLowerCase()} scope (crumbs: "${crumbs.slice(0, 100)}")`);
      else if (expect.value && !crumbs.toLowerCase().includes(expect.value.toLowerCase().replace(/\s+/g, ' ').trim()))
        problems.push(`crumbs name a different ${expect.scopeLabel.toLowerCase()} ("${crumbs.slice(0, 100)}")`);
    }

    // Reporter identity is prefilled from the login (values deliberately not recorded).
    const identity = await within(
      page
        .evaluate(() => {
          const v = (id: string) => ((document.getElementById(id) as HTMLInputElement | null)?.value || '').trim();
          return !!(v('feedback-name') || v('feedback-email'));
        })
        .catch(() => false),
      10_000,
      false,
    );
    if (!identity) problems.push('reporter name/email not prefilled — feedback would be anonymous');

    for (const id of REQUIRED_FIELDS) {
      if ((await page.locator(`#${id}`).count().catch(() => 0)) === 0) problems.push(`#${id} missing from the form`);
    }
    if (await page.locator('#feedback-submit').isDisabled().catch(() => false)) problems.push('submit button disabled');

    // Previous-feedback list (GET /api/feedback/<id>): entries or "No feedback
    // yet" are both fine; "Could not load feedback." means the GET errored.
    const listState = await page
      .waitForFunction(
        () => {
          const list = document.querySelector('#feedback-list');
          if (!list || list.children.length === 0) return null; // still loading
          const empty = list.querySelector('.feedback-list-empty');
          if (empty) return /could not load/i.test(empty.textContent || '') ? 'error' : 'empty';
          return 'entries';
        },
        undefined,
        { timeout: 15_000 },
      )
      .then((h) => h.jsonValue() as Promise<string>)
      .catch(() => 'timeout');
    if (listState === 'error') problems.push('"Previous feedback" failed to load (GET /api/feedback errored)');
    else if (listState === 'timeout') problems.push('"Previous feedback" list never rendered (15s)');

    await page.locator('.feedback-modal-close').click({ timeout: 5_000 });
    await modal.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => problems.push('modal did not close (×)'));
  } catch (e) {
    problems.push(String(e).split('\n')[0].slice(0, 160));
  } finally {
    // Leave the page clean for whatever runs next, whatever happened above.
    if (await page.locator(MODAL).isVisible().catch(() => false))
      await page.evaluate(() => (window as any).closeFeedbackModal?.()).catch(() => {});
  }
  return { ok: problems.length === 0, detail: problems.join('; ') };
}

/** Hover the owning block (reveals the hover-only button), then click normally. */
function hoverClick(btn: Locator, owner: Locator | null) {
  return async () => {
    await btn.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    if (owner) await owner.hover({ timeout: 5_000 }).catch(() => {});
    await btn.click({ timeout: 5_000 });
  };
}

/**
 * Run the feedback audit on the currently-rendered report page. `comps` is the
 * per-component list from the report JSON (positional sIdx/cIdx); `scan` is the
 * shared controls scan (taken here if not supplied).
 */
export async function checkFeedback(page: Page, comps: ComponentRow[], scan?: ControlsScan): Promise<FeedbackCheck[]> {
  const out: FeedbackCheck[] = [];
  const s = scan ?? (await scanControls(page));
  const nSections = s.sectionButtonCount.length;
  console.log(
    `[feedback] buttons: report=${s.reportButtonVisible ? 1 : 0}, ` +
      `sections=${s.sectionButtonCount.filter((n) => n > 0).length}/${nSections}, ` +
      `visuals=${s.components.length}/${comps.length} components`,
  );

  const byKey = new Map<string, MappedComponent>();
  for (const m of s.components) byKey.set(`${m.sIdx}.${m.cIdx}`, m);

  // Report-level button.
  out.push({
    check: 'button',
    scope: 'report',
    section: '',
    component: '',
    type: '',
    state: s.reportButtonVisible ? 'ok' : 'missing',
    detail: s.reportButtonVisible ? '' : 'report header shows no Feedback button',
  });

  // Section-level buttons (unconditional in the app's section header).
  const sectionTitles = new Map<number, string>();
  for (const c of comps) if (!sectionTitles.has(c.sIdx)) sectionTitles.set(c.sIdx, c.section);
  s.sectionButtonCount.forEach((n, si) => {
    out.push({
      check: 'button',
      scope: 'section',
      section: sectionTitles.get(si) ?? `section ${si + 1}`,
      component: '',
      type: '',
      state: n > 0 ? 'ok' : 'missing',
      detail: n > 0 ? '' : 'section header has no Feedback button',
      sectionIndex: si,
    });
  });

  // Component-level buttons — the per-visual requirement.
  for (const c of comps) {
    const hit = byKey.get(`${c.sIdx}.${c.cIdx}`);
    let state: FeedbackCheck['state'];
    let detail = '';
    if (nSections === 0) {
      state = 'na';
      detail = 'report showed "No data available" — no components on screen to check';
    } else if (hit) {
      state = 'ok';
      if (!hit.sectionTitle && c.section)
        detail = 'opens without its section scope (subsection layout never passes the section title)';
    } else if (c.state === 'broken') {
      state = 'na';
      detail = 'component failed to load — its error card has no Feedback button';
    } else if (LAZY_TYPES.has(c.type) && (s.lazyLeft[c.sIdx] ?? 0) > 0) {
      state = 'na';
      detail = 'chart never rendered (lazy placeholder still showing) — could not check';
    } else if (!TYPES_WITH_BUTTON.has(c.type)) {
      state = 'missing';
      detail = `"${c.type || 'unknown'}" components never get a Feedback button in the app`;
    } else {
      state = 'missing';
      detail = `no Feedback button found (expected — ${c.type} components normally have one)`;
    }
    out.push({
      check: 'button',
      scope: 'visual',
      section: c.section,
      component: c.title,
      type: c.type,
      state,
      detail,
      sectionIndex: c.sIdx,
      componentIndex: c.cIdx,
    });
  }

  // Modal — once per scope, through the real controls.
  if (s.reportButtonVisible) {
    const r = await exerciseModal(page, hoverClick(page.locator(REPORT_FEEDBACK_BTN), null), { scopeLabel: '', value: '' });
    out.push({
      check: 'modal',
      scope: 'report',
      section: '',
      component: '',
      type: '',
      state: r.ok ? 'ok' : 'broken',
      detail: r.detail,
    });
  }
  // Prefer a TITLED section: an untitled one legitimately opens with no Section
  // crumb, so it can't show whether the section scope is carried through.
  const withBtn = s.sectionButtonCount.map((_, i) => i).filter((i) => s.sectionButtonCount[i] > 0);
  const secIdx = withBtn.find((i) => s.sectionTitleShown[i]) ?? withBtn[0];
  if (secIdx !== undefined) {
    const shown = s.sectionTitleShown[secIdx] ?? '';
    const sec = page.locator(SECTIONS).nth(secIdx);
    const r = await exerciseModal(page, hoverClick(sec.locator(SECTION_FEEDBACK_BTN).first(), sec.locator('.section-header')), {
      scopeLabel: shown ? 'Section' : '',
      value: shown,
    });
    out.push({
      check: 'modal',
      scope: 'section',
      section: sectionTitles.get(secIdx) ?? shown,
      component: '',
      type: '',
      state: r.ok ? 'ok' : 'broken',
      detail: r.detail,
      sectionIndex: secIdx,
    });
  }
  if (s.components.length > 0) {
    const first = s.components[0];
    const comp = comps.find((c) => c.sIdx === first.sIdx && c.cIdx === first.cIdx);
    const btn = page.locator(SECTIONS).nth(first.sIdx).locator(VISUAL_FEEDBACK_BTN).nth(first.k);
    const r = await exerciseModal(page, hoverClick(btn, btn.locator(OWNER_COMPONENT)), {
      scopeLabel: first.componentTitle ? 'Visual' : '',
      value: first.componentTitle,
    });
    out.push({
      check: 'modal',
      scope: 'visual',
      section: comp?.section ?? first.sectionTitle,
      component: comp?.title ?? first.componentTitle,
      type: comp?.type ?? '',
      state: r.ok ? 'ok' : 'broken',
      detail: r.detail,
      sectionIndex: first.sIdx,
      componentIndex: first.cIdx,
    });
  }

  return out;
}
