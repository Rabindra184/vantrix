import type { DistributionResponse } from '@perfportal/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProblemError } from '../src/api/fetch';
import { distributionQuery } from '../src/api/metrics';
import fixture from './fixtures/reference-run.json';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * ═══ A WINDOW THAT SELECTS NOTHING IS AN EMPTY DISTRIBUTION, NOT A 404 TO RELAY ═══
 *
 * `/distribution` answers 404 when a windowed read selects no buckets, and the
 * Report's two distribution charts used to print that developer sentence — "No
 * response_time histogram for run "" in run <id>. … every row this run
 * recorded." — while every sibling chart said which window was empty. The query
 * turns THAT 404, and only that one, into the empty payload the transforms
 * already explain.
 *
 * Each case is one corner of the same rule: the window-and-404 corner converts,
 * and every neighbour (no window, another status) is left exactly as it was.
 */

const RUN_ID = (fixture.distribution as DistributionResponse).runId;
const WINDOW = { fromMs: 62000, toMs: 63000, bucketWidthMs: 1000 };

function answer(status: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Not found',
            status,
            code: status === 404 ? 'NOT_FOUND' : 'INTERNAL',
            detail: 'No response_time histogram for run "" in run x.',
            remediation: 'Check the scope, name and family.',
          }),
          { status, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    ),
  );
}

describe('distributionQuery — a windowed read that selects no buckets', () => {
  it('resolves to an EMPTY distribution instead of relaying the 404', async () => {
    answer(404);
    const d = await distributionQuery(RUN_ID, 'run', '', 'response_time', WINDOW).queryFn();

    // The shape the transforms explain: no bins at all, and not a distribution
    // that happens to hold zeros.
    expect(d.labels).toEqual([]);
    expect(d.okCount).toEqual([]);
    expect(d.koCount).toEqual([]);
    expect(d.overflowCount).toBe(0);
    // Carries the request's own identity rather than inventing one.
    expect(d.runId).toBe(RUN_ID);
    expect([d.scope, d.name, d.family]).toEqual(['run', '', 'response_time']);
  });

  /** No window means a run with no histogram at all, which `Payload` relays on
   *  purpose — and the drill-downs, which never pass a window, rely on it. */
  it('still relays the 404 when no window is selected', async () => {
    answer(404);
    await expect(distributionQuery(RUN_ID, 'run', '', 'response_time', null).queryFn()).rejects.toBeInstanceOf(
      ProblemError,
    );
  });

  /** Only the 404 is "the window held nothing"; a server failure is not. */
  it('still throws any other failure under a window', async () => {
    answer(500);
    await expect(
      distributionQuery(RUN_ID, 'run', '', 'response_time', WINDOW).queryFn(),
    ).rejects.toMatchObject({ status: 500 });
  });
});
