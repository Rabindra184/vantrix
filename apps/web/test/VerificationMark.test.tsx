import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FigureMismatch, GatlingDifference, RunStatus, Verification, VerificationSummary } from '@perfportal/contracts';
import VerificationMark from '../src/routes/VerificationMark';
import { mismatchKeys } from '../src/routes/VerificationPanel';
import { VERIFICATION } from '../src/routes/marks';

// No vitest globals here, so Testing Library's automatic cleanup never
// registers; without this every render stacks in one `document.body`.
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const RUN_ID = 'a66548b7-2962-43ff-8b93-7149a6f2a1b8';
const PATH = `/v1/runs/${RUN_ID}/verification`;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Answers the verification endpoint with `answer`; records every URL asked for. */
function stub(answer: () => Response): string[] {
  const seen: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    seen.push(String(input));
    return Promise.resolve(String(input) === PATH ? answer() : json(404, {}));
  });
  return seen;
}

function renderMark(status: RunStatus, summary: VerificationSummary | null | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VerificationMark runId={RUN_ID} status={status} summary={summary} />
    </QueryClientProvider>,
  );
}

const VERIFIED: Verification = {
  status: 'verified',
  reason: null,
  checkedAt: '2026-10-16T09:30:00.000Z',
  verifierVersion: 3,
  figuresChecked: 1482,
  mismatches: [],
  rawLogRetainedUntil: '2027-01-14',
  rawLogDeleted: false,
};

const mismatch = (over: Partial<FigureMismatch> = {}): FigureMismatch => ({
  scope: 'request',
  name: 'Search',
  family: 'response_time',
  population: 'all',
  bucket: null,
  table: 'run_stat',
  figure: 'p95',
  stored: 658,
  recomputed: 661,
  ...over,
});

const trigger = () => screen.getByTestId('run-verification');

describe('VerificationMark — the mark', () => {
  it.each([
    ['verified', VERIFICATION.verified],
    ['mismatch', VERIFICATION.mismatch],
    ['pending', VERIFICATION.pending],
    ['unverifiable', VERIFICATION.unverifiable],
  ] as const)('draws %s as its own mark', (status, mark) => {
    renderMark('complete', { status, reason: status === 'unverifiable' ? 'raw_log_missing' : null });
    expect(trigger()).toHaveTextContent(mark.label);
  });

  it('reads the four states with four different words and shapes, and the right colours', () => {
    const marks = Object.values(VERIFICATION);
    expect(new Set(marks.map((m) => m.label)).size).toBe(4);
    expect(new Set(marks.map((m) => m.glyph)).size).toBe(4);
    expect(VERIFICATION.verified).toMatchObject({ glyph: '✓', label: 'Verified', colour: 'var(--color-status-passed)' });
    expect(VERIFICATION.mismatch).toMatchObject({ glyph: '✕', label: 'Verification failed', colour: 'var(--color-status-failed)' });
    expect(VERIFICATION.pending.label).toBe('Verifying…');
    expect(VERIFICATION.unverifiable.label).toBe('Not verified');
  });

  /** The API answers `pending` for a run the verifier has not reached; null
   *  means the run has no statistics to verify. "Verifying…" there would be
   *  said for ever — an incomplete run nothing processed never gets a row. */
  it.each([null, undefined])('draws nothing for a terminal run that is not verifiable (summary %s)', (summary) => {
    renderMark('incomplete', summary);
    expect(screen.queryByTestId('run-verification')).toBeNull();
    expect(screen.queryByText(/verif/i)).toBeNull();
  });

  it('reads a pending summary as verifying', () => {
    renderMark('complete', { status: 'pending', reason: null });
    expect(trigger()).toHaveTextContent('Verifying…');
  });

  it('marks an incomplete run too — its statistics are kept', () => {
    renderMark('incomplete', { status: 'verified', reason: null });
    expect(trigger()).toHaveTextContent('Verified');
  });

  /** A run still being measured, or one that produced no statistics, has
   *  nothing to verify — a "Verifying…" there would be a claim about figures
   *  that do not exist yet. */
  it.each(['pending', 'parsing', 'running', 'failed'] as const)('draws nothing for a %s run', (status) => {
    renderMark(status, { status: 'verified', reason: null });
    expect(screen.queryByTestId('run-verification')).toBeNull();
    expect(screen.queryByText(/verif/i)).toBeNull();
  });

  it.each([
    ['raw_log_deleted', /raw log was deleted before this run was checked/i],
    ['raw_log_missing', /raw log could not be found/i],
    ['raw_log_unreadable', /raw log could not be read/i],
    ['not_exact', /statistics are estimates; see ≈/],
  ] as const)('says why a run is not verified (%s) behind its ⓘ', (reason, words) => {
    renderMark('complete', { status: 'unverifiable', reason });
    expect(screen.getByRole('button', { name: 'Why this run is not verified' })).toHaveAccessibleDescription(words);
  });

  it('carries no ⓘ for any other status', () => {
    renderMark('complete', { status: 'mismatch', reason: null });
    expect(screen.queryByRole('button', { name: 'Why this run is not verified' })).toBeNull();
  });
});

describe('VerificationMark — the panel', () => {
  it('asks for the verification only once it is opened', async () => {
    const seen = stub(() => json(200, VERIFIED));
    renderMark('complete', { status: 'verified', reason: null });
    // Give a page-load fetch every chance to have happened.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).not.toContain(PATH);

    await userEvent.setup().click(trigger());
    const panel = await screen.findByRole('dialog', { name: 'Verification' });
    expect(seen).toContain(PATH);
    await within(panel).findByText('1482');
  });

  it('shows the figures checked, the verifier version, the time and how long the raw log is kept', async () => {
    stub(() => json(200, VERIFIED));
    renderMark('complete', { status: 'verified', reason: null });
    await userEvent.setup().click(trigger());
    const panel = await screen.findByRole('dialog', { name: 'Verification' });
    await within(panel).findByText('1482');
    expect(panel).toHaveTextContent(/Figures checked\s*1482/);
    expect(panel).toHaveTextContent(/Verifier version\s*3/);
    expect(panel).toHaveTextContent(/Checked/);
    expect(panel).toHaveTextContent(/kept until 2027-01-14/);
    // A verified run has nothing to tabulate.
    expect(within(panel).queryByRole('table')).toBeNull();
  });

  it.each([
    [{ rawLogRetainedUntil: null, rawLogDeleted: false }, /kept indefinitely/],
    [{ rawLogRetainedUntil: '2026-10-01', rawLogDeleted: true }, /deleted/],
  ])('says what happened to the raw log', async (over, words) => {
    stub(() => json(200, { ...VERIFIED, ...over }));
    renderMark('complete', { status: 'verified', reason: null });
    await userEvent.setup().click(trigger());
    const panel = await screen.findByRole('dialog', { name: 'Verification' });
    await within(panel).findByText('1482');
    expect(within(panel).getByTestId('verification-raw-log')).toHaveTextContent(words);
  });

  it('tabulates every mismatch with its table, row, figure and both values', async () => {
    stub(() =>
      json(200, {
        ...VERIFIED,
        status: 'mismatch',
        mismatches: [
          mismatch(),
          mismatch({ table: 'run_series_bucket', scope: 'run', name: '', bucket: 12000, figure: 'ok_count', stored: 40, recomputed: 41 }),
        ],
      }),
    );
    renderMark('complete', { status: 'mismatch', reason: null });
    await userEvent.setup().click(trigger());
    const panel = await screen.findByRole('dialog', { name: 'Verification' });
    const table = await within(panel).findByRole('table', { name: 'Mismatches' });
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Table',
      'Row',
      'Figure',
      'Stored',
      'Recomputed',
    ]);
    const [first, second] = within(table).getAllByRole('row').slice(1) as [HTMLElement, HTMLElement];
    expect(first).toHaveTextContent(/request · Search · response_time/);
    expect(first).toHaveTextContent(/p95/);
    expect(first).toHaveTextContent(/658/);
    expect(first).toHaveTextContent(/661/);
    // The bucket's offset, so a reader can find WHICH second disagrees.
    expect(second).toHaveTextContent(/12s/);
  });

  /** For the two error tables `family` carries the error MESSAGE — an empty
   *  one is the folded "other" row — so the row is named by message there,
   *  never as though the message were a statistics family. */
  it('names an error-table row by its message, and the empty message as the other errors', async () => {
    stub(() =>
      json(200, {
        ...VERIFIED,
        status: 'mismatch',
        mismatches: [
          mismatch({ table: 'run_error', scope: 'request', name: 'Search', family: 'Connection refused', population: null, figure: 'count', stored: 3, recomputed: 4 }),
          mismatch({ table: 'run_error_bucket', scope: 'run', name: '', family: '', population: null, bucket: 3000, figure: 'count', stored: 1, recomputed: 2 }),
        ],
      }),
    );
    renderMark('complete', { status: 'mismatch', reason: null });
    await userEvent.setup().click(trigger());
    const table = await screen.findByRole('table', { name: 'Mismatches' });
    const [first, second] = within(table).getAllByRole('row').slice(1) as [HTMLElement, HTMLElement];
    expect(first).toHaveTextContent('request · Search · “Connection refused”');
    expect(second).toHaveTextContent(/other errors/);
    expect(second).toHaveTextContent(/3s/);
  });

  it('shows the first 50 mismatches and counts the rest', async () => {
    const many = Array.from({ length: 57 }, (_, i) => mismatch({ name: `R${i}` }));
    stub(() => json(200, { ...VERIFIED, status: 'mismatch', mismatches: many }));
    renderMark('complete', { status: 'mismatch', reason: null });
    await userEvent.setup().click(trigger());
    const table = await screen.findByRole('table', { name: 'Mismatches' });
    expect(within(table).getAllByRole('row')).toHaveLength(51);
    expect(screen.getByRole('dialog', { name: 'Verification' })).toHaveTextContent('and 7 more');
  });

  it('says once that the verification could not be loaded, and draws no table', async () => {
    stub(() => json(500, { type: 'about:blank', title: 'Error', status: 500, code: 'INTERNAL', detail: 'x', remediation: 'y' }));
    renderMark('complete', { status: 'mismatch', reason: null });
    await userEvent.setup().click(trigger());
    const panel = await screen.findByRole('dialog', { name: 'Verification' });
    await within(panel).findByText('The verification could not be loaded.');
    expect(within(panel).queryByRole('table')).toBeNull();
  });

  it('closes on Escape and returns focus to the mark', async () => {
    stub(() => json(200, VERIFIED));
    renderMark('complete', { status: 'verified', reason: null });
    const user = userEvent.setup();
    trigger().focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: 'Verification' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger()).toHaveFocus();
  });
});

const difference = (over: Partial<GatlingDifference> = {}): GatlingDifference => ({
  scope: 'request',
  name: 'Session',
  population: 'all',
  figure: 'p95',
  gatlingLow: 2389,
  gatlingHigh: 3410,
  exact: 2401,
  ...over,
});

/** Opens the panel over `verification` and returns it once it has loaded. */
async function openPanel(verification: Verification): Promise<HTMLElement> {
  stub(() => json(200, verification));
  renderMark('complete', { status: verification.status, reason: null });
  await userEvent.setup().click(trigger());
  const panel = await screen.findByRole('dialog', { name: 'Verification' });
  await within(panel).findByText(String(verification.figuresChecked));
  return panel;
}

const DIFFERENCES = /Differences from Gatling’s report/;

describe('VerificationPanel — differences from Gatling’s report', () => {
  it('draws the table when there are differences', async () => {
    const panel = await openPanel({
      ...VERIFIED,
      gatlingReplays: 16,
      gatlingDifferences: [
        difference({ scope: 'run', name: '', figure: 'p99', gatlingLow: 2349, gatlingHigh: 2412, exact: 2503 }),
        difference({ scope: 'request', name: 'Cart/Add To Cart' }),
        difference({ scope: 'group', name: 'Catalog', figure: 'p75', gatlingLow: 141, gatlingHigh: 141, exact: 140 }),
      ],
    });
    const table = within(panel).getByRole('table', { name: 'Differences from Gatling’s report' });
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Request',
      'Figure',
      'Gatling’s report',
      'PerfPortal',
    ]);
    const [run, request, group] = within(table).getAllByRole('row').slice(1) as [HTMLElement, HTMLElement, HTMLElement];
    // The run is "All requests"; a request or group is "scope · stored name",
    // the mismatch table's rule — the stored name is the path the request and
    // group pages head themselves with.
    expect(within(run).getAllByRole('cell').map((td) => td.textContent)).toEqual(['All requests', 'p99', '2349–2412', '2503']);
    expect(within(request).getAllByRole('cell')[0]).toHaveTextContent(/^request · Cart\/Add To Cart$/);
    expect(within(group).getAllByRole('cell')[0]).toHaveTextContent(/^group · Catalog$/);
    // A verified run with differences: they are Gatling's variance, not a mismatch.
    expect(within(panel).queryByRole('table', { name: 'Mismatches' })).toBeNull();
  });

  it.each([
    ['empty', { gatlingDifferences: [], gatlingReplays: 16 }],
    ['absent', {}],
  ])('no table when the list is %s', async (_, over) => {
    const panel = await openPanel({ ...VERIFIED, ...over });
    expect(within(panel).queryByRole('table')).toBeNull();
    expect(panel).not.toHaveTextContent(DIFFERENCES);
    // No ⓘ either: a caveat about a table that is not there explains nothing.
    expect(within(panel).queryByRole('button', { name: /Gatling/ })).toBeNull();
  });

  /**
   * PLAIN DIGITS, as every figure on the run page is written — the statistics
   * table and the p95 tile print 2401, and so does this popover's own
   * "Figures checked". A separator here would set "2,401" beside them.
   */
  it('a range renders low–high in plain digits', async () => {
    const panel = await openPanel({ ...VERIFIED, gatlingDifferences: [difference()] });
    const row = within(within(panel).getByRole('table', { name: 'Differences from Gatling’s report' })).getAllByRole('row')[1]!;
    const [, , gatling, exact] = within(row).getAllByRole('cell');
    expect(gatling).toHaveTextContent(/^2389–3410$/);
    expect(exact).toHaveTextContent(/^2401$/);
  });

  it('a single value renders once', async () => {
    const panel = await openPanel({
      ...VERIFIED,
      gatlingDifferences: [difference({ gatlingLow: 1853, gatlingHigh: 1853, exact: 1851 })],
    });
    const row = within(within(panel).getByRole('table', { name: 'Differences from Gatling’s report' })).getAllByRole('row')[1]!;
    expect(within(row).getAllByRole('cell')[2]).toHaveTextContent(/^1853$/);
  });

  /**
   * A group's percentile is its CUMULATED response time; a group named like a
   * request must not read as that request's figure.
   */
  it('a group reads as a group, apart from a request of the same name', async () => {
    const panel = await openPanel({
      ...VERIFIED,
      gatlingDifferences: [difference({ scope: 'request', name: 'Cart' }), difference({ scope: 'group', name: 'Cart' })],
    });
    const table = within(panel).getByRole('table', { name: 'Differences from Gatling’s report' });
    const labels = within(table).getAllByRole('row').slice(1).map((tr) => within(tr).getAllByRole('cell')[0]!.textContent);
    expect(labels).toEqual(['request · Cart', 'group · Cart']);
  });

  it('shows the first 50 differences and counts the rest', async () => {
    const many = Array.from({ length: 57 }, (_, i) => difference({ name: `R${i}` }));
    const panel = await openPanel({ ...VERIFIED, gatlingDifferences: many });
    const table = within(panel).getByRole('table', { name: 'Differences from Gatling’s report' });
    expect(within(table).getAllByRole('row')).toHaveLength(51);
    expect(within(panel).getByTestId('gatling-differences')).toHaveTextContent('and 7 more');
  });

  it('OK/KO population is named', async () => {
    const panel = await openPanel({
      ...VERIFIED,
      gatlingDifferences: [
        difference({ population: 'ok', figure: 'p95' }),
        difference({ population: 'ko', figure: 'p99' }),
        difference({ population: 'all', figure: 'p50' }),
      ],
    });
    const table = within(panel).getByRole('table', { name: 'Differences from Gatling’s report' });
    const figures = within(table).getAllByRole('row').slice(1).map((tr) => within(tr).getAllByRole('cell')[1]!.textContent);
    expect(figures).toEqual(['p95 (OK)', 'p99 (KO)', 'p50']);
  });

  it('the ⓘ carries the copy', async () => {
    const panel = await openPanel({ ...VERIFIED, gatlingDifferences: [difference()] });
    expect(panel).toHaveTextContent(DIFFERENCES);
    const tip = within(panel).getByRole('button', { name: 'About differences from Gatling’s report' });
    expect(tip).toHaveAccessibleDescription(
      'Gatling’s report estimates percentiles with t-digest, and its estimate can change between two reports of the same run; PerfPortal reports the actual value at that rank.',
    );
  });
});

describe('VerificationPanel — row keys', () => {
  /** An index key moves with the list: a row would take another's identity. */
  it('keys a mismatch by what it is, so it keeps its key when one above it goes', () => {
    const a = mismatch({ figure: 'p50' });
    const b = mismatch({ figure: 'p95' });
    const c = mismatch({ table: 'run_series_bucket', bucket: 4000, figure: 'ok_count', population: null });
    const before = mismatchKeys([a, b, c]);
    const after = mismatchKeys([b, c]);
    expect(after).toEqual(before.slice(1));
  });

  it('keeps two mismatches at one place apart', () => {
    const extra = mismatch({ figure: 'row', population: null, stored: 3, recomputed: null });
    const keys = mismatchKeys([extra, extra, mismatch()]);
    expect(new Set(keys).size).toBe(3);
  });
});
