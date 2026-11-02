import { expect, test, type Page } from '@playwright/test';
import {
  enableOrgAi,
  processAiAnalysis,
  seedAdmin,
  seedProjectMember,
  seedRunWithData,
} from './fixtures.js';
import { signIn } from './helpers.js';
import { runPath } from '../src/routes/paths.js';

/**
 * ═══ THE AI RUN ANALYSIS, IN A BROWSER ═══
 * (docs/superpowers/specs/2026-11-02-ai-run-analysis-design.md)
 *
 * The unit layer hands `AiAnalysisCard` its payload; these prove the seams no
 * jsdom case reaches: a Member's click reaching the real POST, the real worker
 * service writing a checked analysis (against `ai-stub.ts`, whose answer
 * copies the run's own facts), the card's polling picking it up, and a reload
 * reading it back from the database. Plus the two properties only a browser
 * measures: that the card is ABSENT for every run of an org that has not
 * switched AI on — which is what keeps the rest of this suite untouched now
 * that the API is configured with a provider — and where it sits.
 */

/** The narrow shape of a stored analysis these cases read; the e2e suite keeps its own types. */
interface Content {
  health: { headline: string; bullets: string[] };
  insights: {
    headline: string;
    errors: string[];
    assertions: string[];
    injectionProfile: string[];
    responseTimes: string[];
  };
  recommendations: { headline: string; bullets: string[] };
}

/** Every line of text an analysis carries, in the order the card draws them. */
function linesOf(c: Content): string[] {
  return [
    c.health.headline,
    ...c.health.bullets,
    c.insights.headline,
    ...c.insights.errors,
    ...c.insights.assertions,
    ...c.insights.injectionProfile,
    ...c.insights.responseTimes,
    c.recommendations.headline,
    ...c.recommendations.bullets,
  ];
}

/** The run's own numbers, as `mobile.spec.ts` names them: the first tile of the totals. */
const TOTALS = 'section[aria-label="Run totals"]';
const FIRST_TILE = `${TOTALS} dd[data-testid^="stat-"]`;

/** An element's top and bottom in DOCUMENT coordinates, so a scroll cannot move them. */
async function edgesOf(page: Page, selector: string): Promise<{ top: number; bottom: number }> {
  return page.locator(selector).first().evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { top: Math.round(box.top + window.scrollY), bottom: Math.round(box.bottom + window.scrollY) };
  });
}

test('a member generates an analysis and it survives a reload', async ({ page }) => {
  const admin = await seedAdmin();
  const member = await seedProjectMember(admin.orgId, admin.projectId, 'member', 'Rowan Hale');
  const runId = await seedRunWithData(admin.orgId);
  await enableOrgAi(admin.orgId);

  await signIn(page, member);
  await page.goto(runPath(runId));

  const card = page.getByTestId('ai-analysis');
  // Asserted before the click, so a card that never mounts fails here in
  // seconds rather than as a click waiting out the whole test budget.
  const analyze = card.getByRole('button', { name: 'Analyze with AI' });
  await expect(analyze).toBeVisible({ timeout: 15_000 });
  await analyze.click();
  // The POST's own answer, written into the read's key: the row is pending,
  // and the card is now polling it.
  await expect(card.getByRole('status')).toHaveText('Analysing this run…');
  // The button went with the state it belonged to; the reader's place is the
  // card's heading, not the page.
  await expect(card.getByRole('heading', { level: 2, name: 'AI run analysis' })).toBeFocused();

  const content = (await processAiAnalysis(runId)) as Content;

  // The card polls every 3s (`AI_ANALYSIS_POLL_MS`), so the ready analysis
  // arrives on a later read with nothing reloaded.
  await expect(card.getByText(content.health.headline)).toBeVisible({ timeout: 15_000 });
  // The card's one live region, still mounted, says the wait is over.
  await expect(card.getByRole('status')).toHaveText('Analysis ready.');

  /** What the card must show for a ready analysis: every line, and its provenance. */
  const expectReady = async (): Promise<void> => {
    for (const line of linesOf(content)) {
      await expect(card.getByText(line, { exact: true })).toBeVisible();
    }
    await expect(card).toContainText('Generated on');
    // A ready, current analysis offers no way to ask again: it would answer
    // the same text, at the operator's expense.
    await expect(card.getByRole('button', { name: /analyze with ai|generate again|try again/i })).toHaveCount(0);
  };
  await expectReady();

  // The numbers the analysis cites are this run's numbers as the Summary
  // prints them: the stub copied the facts' display strings, and the facts
  // and the tiles format the same figures the same way.
  const total = (await page.getByTestId('stat-total-requests').textContent())?.trim() ?? '';
  const p95 = (await page.getByTestId('stat-p95').textContent())?.trim() ?? '';
  expect(total, 'the total-requests tile has a value').not.toBe('');
  expect(content.health.bullets.join(' ')).toContain(total);
  expect(content.insights.responseTimes.join(' ')).toContain(p95);

  // From the database, not the cache: a reload drops React Query's state.
  await page.reload();
  await expectReady();
  // Nobody waited through this one, so there is nothing to announce.
  await expect(card.getByRole('status')).toHaveText('');
});

test('the card does not appear while the org switch is off', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  // The card's read, answered: without waiting for it an absent card proves
  // only that it had not loaded yet.
  const answered = page.waitForResponse(
    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === `/v1/runs/${runId}/ai-analysis`,
    { timeout: 15_000 },
  );
  await page.goto(runPath(runId));
  const response = await answered;
  expect(response.status()).toBe(200);
  // `org_disabled`, not `not_configured`: the API IS configured with a
  // provider (playwright.config.ts), so this is the state every other spec on
  // a run Summary now renders in — and it draws nothing.
  expect(await response.json()).toEqual({ available: false, reason: 'org_disabled' });

  await expect(page.locator(FIRST_TILE).first()).toBeVisible();
  await expect(page.getByTestId('ai-analysis')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'AI run analysis' })).toHaveCount(0);
});

test('the card sits after the run totals', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await enableOrgAi(admin.orgId);
  await signIn(page, admin);

  const card = page.getByTestId('ai-analysis');
  const measure = async (): Promise<{ cardTop: number; totalsBottom: number; firstTileTop: number }> => {
    await page.goto(runPath(runId));
    await expect(card.getByRole('button', { name: 'Analyze with AI' })).toBeVisible();
    await expect(page.locator(FIRST_TILE).first()).toBeVisible();
    const cardEdges = await edgesOf(page, '[data-testid="ai-analysis"]');
    const totals = await edgesOf(page, TOTALS);
    const firstTile = await edgesOf(page, FIRST_TILE);
    return { cardTop: cardEdges.top, totalsBottom: totals.bottom, firstTileTop: firstTile.top };
  };

  const desktop = await measure();
  expect(desktop.cardTop, 'the card follows the run totals').toBeGreaterThanOrEqual(desktop.totalsBottom);

  // A phone draws the card too (it is text, never behind `DesktopOnly`), and
  // it must not cost the fold: `mobile.spec.ts`'s bound, with the card mounted.
  await page.setViewportSize({ width: 375, height: 812 });
  const phone = await measure();
  expect(phone.cardTop, 'the card follows the run totals on a phone').toBeGreaterThanOrEqual(phone.totalsBottom);
  expect(phone.firstTileTop, 'the run’s own numbers start inside the first screen').toBeLessThan(812);
});
