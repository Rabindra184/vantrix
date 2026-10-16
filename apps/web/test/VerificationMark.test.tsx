import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FigureMismatch, RunStatus, Verification, VerificationSummary } from '@perfportal/contracts';
import VerificationMark from '../src/routes/VerificationMark';
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
