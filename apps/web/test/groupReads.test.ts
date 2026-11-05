import type { DistributionResponse, SeriesResponse } from '@perfportal/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProblemError } from '../src/api/fetch';
import { groupDistributionPath, groupSeriesPath } from '../src/api/metricPaths';
import {
  GroupReadUnsupportedError,
  distributionQuery,
  groupDistributionQuery,
  groupSeriesQuery,
  seriesQuery,
} from '../src/api/metrics';
import fixture from './fixtures/reference-run.json';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * ═══ A GROUP READ IS ONLY BELIEVED WHEN IT ECHOES ITS GROUP ═══
 * (the Report pickers spec, sections 4 and 7; controller ruling R7)
 *
 * An API pod older than `?group=` ignores the parameter it does not know and
 * answers a 200 — the run's own data, or request `''`'s nothing — so a group
 * pick would draw figures that are not the group's, with nothing failing. The
 * response's `group` echo is the only thing that tells the two apart, so the
 * query refuses any body whose `group` is not exactly the group it asked for.
 */

const SERIES = fixture.series as SeriesResponse;
const DISTRIBUTION = fixture.distribution as DistributionResponse;
const RUN_ID = SERIES.runId;
const WINDOW = { fromMs: 10000, toMs: 30000, bucketWidthMs: 1000 };

/** What a group read on THIS server answers: request scope, no name, the group echoed. */
const echoed = <T extends object>(body: T, group: string | null) => ({ ...body, scope: 'request', name: '', group });

/** Answers every fetch with `status` and `body`, and records what was asked for. */
function answer(status: number, body: unknown): string[] {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      asked.push(url);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': status < 300 ? 'application/json' : 'application/problem+json' },
        }),
      );
    }),
  );
  return asked;
}

const problem = (status: number, code: string) => ({
  type: 'about:blank',
  title: code,
  status,
  code,
  detail: `A ${status} for a group read.`,
  remediation: 'Read its requests one at a time.',
});

describe('groupSeriesQuery — the echo', () => {
  // The case's premise: the captured fixture predates `group`, so it IS an
  // older pod's body. A re-capture that gained the key would make the first
  // case pass for the wrong reason.
  it('starts from a body that carries no group at all', () => {
    expect('group' in SERIES).toBe(false);
  });

  it('refuses a body without group, which an older server answers', async () => {
    answer(200, SERIES);
    await expect(groupSeriesQuery(RUN_ID, 'Cart', null).queryFn()).rejects.toBeInstanceOf(GroupReadUnsupportedError);
  });

  it('refuses group: null, the echo of an ordinary read', async () => {
    answer(200, echoed(SERIES, null));
    await expect(groupSeriesQuery(RUN_ID, 'Cart', null).queryFn()).rejects.toBeInstanceOf(GroupReadUnsupportedError);
  });

  it('refuses the echo of another group', async () => {
    answer(200, echoed(SERIES, 'Catalog'));
    await expect(groupSeriesQuery(RUN_ID, 'Cart', null).queryFn()).rejects.toBeInstanceOf(GroupReadUnsupportedError);
    // '' is (no group), a different group from Cart, however falsy it is.
    answer(200, echoed(SERIES, ''));
    await expect(groupSeriesQuery(RUN_ID, 'Cart', null).queryFn()).rejects.toBeInstanceOf(GroupReadUnsupportedError);
  });

  it('resolves a body that echoes its group, read from the group path', async () => {
    const asked = answer(200, echoed(SERIES, 'Cart'));
    const series = await groupSeriesQuery(RUN_ID, 'Cart', WINDOW).queryFn();
    expect(series.group).toBe('Cart');
    expect(series.buckets).toEqual(SERIES.buckets);
    expect(asked).toEqual([groupSeriesPath(RUN_ID, 'Cart', 'response_time', WINDOW)]);
  });

  it('resolves (no group): an empty echo is an echo', async () => {
    answer(200, echoed(SERIES, ''));
    await expect(groupSeriesQuery(RUN_ID, '', null).queryFn()).resolves.toMatchObject({ group: '' });
  });

  it('says what a reader is shown', () => {
    expect(new GroupReadUnsupportedError('Cart', undefined).message).toBe('This server cannot narrow by group yet.');
  });

  // R7(c): a run whose members cannot be merged exactly is the server's own
  // answer, worded by the Report — never mistaken for an older server.
  it('lets a 409 through as the ProblemError it is', async () => {
    answer(409, problem(409, 'GROUP_NOT_MERGEABLE'));
    const read = groupSeriesQuery(RUN_ID, 'Cart', null).queryFn();
    await expect(read).rejects.toBeInstanceOf(ProblemError);
    await expect(read).rejects.toMatchObject({ status: 409, code: 'GROUP_NOT_MERGEABLE' });
  });
});

describe('groupSeriesQuery — its cache entry', () => {
  /**
   * A group's OWN series (`scope=group&name=Cart`, the group drill-down) and
   * its requests merged are different answers; under `staleTime: Infinity` a
   * shared key would serve one for the other for the life of the page.
   */
  it('never shares a key with an ordinary series read', () => {
    const key = groupSeriesQuery(RUN_ID, 'Cart', null).queryKey;
    for (const scope of ['run', 'group', 'request']) {
      for (const name of ['', 'Cart']) {
        expect(key).not.toEqual(seriesQuery(RUN_ID, scope, name, 'response_time', null).queryKey);
      }
    }
    expect(key).not.toEqual(groupSeriesQuery(RUN_ID, '', null).queryKey);
    expect(key).not.toEqual(groupSeriesQuery(RUN_ID, 'Cart', WINDOW).queryKey);
  });

  it('sits under the run’s series prefix, so invalidating the run’s series reaches it', () => {
    expect(groupSeriesQuery(RUN_ID, 'Cart', null).queryKey.slice(0, 3)).toEqual(['run', RUN_ID, 'series']);
    expect(groupDistributionQuery(RUN_ID, 'Cart', null).queryKey.slice(0, 3)).toEqual([
      'run',
      RUN_ID,
      'distribution',
    ]);
    expect(groupDistributionQuery(RUN_ID, 'Cart', null).queryKey).not.toEqual(
      distributionQuery(RUN_ID, 'group', 'Cart', 'response_time', null).queryKey,
    );
  });
});

describe('groupDistributionQuery — the echo, and what a 404 means', () => {
  it('refuses a body without group', async () => {
    answer(200, DISTRIBUTION);
    await expect(groupDistributionQuery(RUN_ID, 'Cart', null).queryFn()).rejects.toBeInstanceOf(
      GroupReadUnsupportedError,
    );
  });

  it('resolves a body that echoes its group, read from the group path', async () => {
    const asked = answer(200, echoed(DISTRIBUTION, 'Cart'));
    const d = await groupDistributionQuery(RUN_ID, 'Cart', null).queryFn();
    expect(d.labels).toEqual(DISTRIBUTION.labels);
    expect(asked).toEqual([groupDistributionPath(RUN_ID, 'Cart', 'response_time', null)]);
  });

  /**
   * A 404 carries no echo. It is what EVERY group distribution read gets from
   * a server older than `group` (it reads request `''`, which no run has), and
   * this server answers it only for a group it does not know, which the
   * picker cannot offer.
   */
  it('reads an unwindowed 404 as a server that cannot narrow', async () => {
    answer(404, problem(404, 'NOT_FOUND'));
    await expect(groupDistributionQuery(RUN_ID, 'Cart', null).queryFn()).rejects.toBeInstanceOf(
      GroupReadUnsupportedError,
    );
  });

  /**
   * NOT an empty window, unlike `distributionQuery`'s windowed 404: this
   * server answers a quiet window with a 200, so under a window a 404 is still
   * an older server — and an empty payload here would draw its refusal as
   * "nothing fell in the selected window".
   */
  it('reads a windowed 404 as a server that cannot narrow, never as an empty window', async () => {
    answer(404, problem(404, 'NOT_FOUND'));
    await expect(groupDistributionQuery(RUN_ID, 'Cart', WINDOW).queryFn()).rejects.toBeInstanceOf(
      GroupReadUnsupportedError,
    );
  });

  /** The quiet window as this server answers it: a 200 with no bins and the echo. */
  it('resolves a windowed 200 with no bins and the echo as an empty window', async () => {
    answer(
      200,
      echoed(
        { ...DISTRIBUTION, labels: [], okCount: [], koCount: [], okPercent: [], koPercent: [], overflowCount: 0 },
        'Cart',
      ),
    );
    const d = await groupDistributionQuery(RUN_ID, 'Cart', WINDOW).queryFn();
    expect([d.labels, d.okCount, d.koCount]).toEqual([[], [], []]);
    expect([d.runId, d.scope, d.name, d.group, d.family]).toEqual([RUN_ID, 'request', '', 'Cart', 'response_time']);
  });

  it('lets a 409 through, windowed or not', async () => {
    for (const w of [null, WINDOW]) {
      answer(409, problem(409, 'GROUP_NOT_MERGEABLE'));
      await expect(groupDistributionQuery(RUN_ID, 'Cart', w).queryFn()).rejects.toMatchObject({
        status: 409,
        code: 'GROUP_NOT_MERGEABLE',
      });
    }
  });

  it('still throws any other failure as the ProblemError it is', async () => {
    answer(500, problem(500, 'INTERNAL'));
    const read = groupDistributionQuery(RUN_ID, 'Cart', WINDOW).queryFn();
    await expect(read).rejects.toBeInstanceOf(ProblemError);
    await expect(read).rejects.toMatchObject({ status: 500 });
  });
});
