import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import type { RecomputeRepository } from '@perfportal/persistence';
import { parseRecomputeArgs } from '../src/recompute/recompute-args.js';
import { createRecomputeScan } from '../src/recompute/recompute-queue.js';

const RUN = '0b9c8f4e-2d3a-4c1b-9e7f-1a2b3c4d5e6f';

describe('parseRecomputeArgs', () => {
  it('reads --project', () => {
    expect(parseRecomputeArgs(['--project', 'checkout'])).toEqual({ projectSlug: 'checkout' });
  });

  it('reads --run', () => {
    expect(parseRecomputeArgs(['--run', RUN])).toEqual({ runId: RUN });
  });

  it('reads both together', () => {
    expect(parseRecomputeArgs(['--project', 'checkout', '--run', RUN])).toEqual({
      projectSlug: 'checkout',
      runId: RUN,
    });
  });

  it('answers {} for no arguments', () => {
    expect(parseRecomputeArgs([])).toEqual({});
  });

  it('refuses --project with no value', () => {
    expect(() => parseRecomputeArgs(['--project'])).toThrow(/--project requires a value/);
  });

  it('refuses a value that is the next flag', () => {
    expect(() => parseRecomputeArgs(['--project', '--run', 'x'])).toThrow(/looks like another flag/);
  });

  it('refuses an unknown flag', () => {
    expect(() => parseRecomputeArgs(['--frobnicate'])).toThrow(/Unknown argument "--frobnicate"/);
  });

  it('refuses a --run that is not a uuid', () => {
    expect(() => parseRecomputeArgs(['--run', 'abc'])).toThrow(/--run expects a run id/);
  });
});

describe('createRecomputeScan', () => {
  function fakes(candidates: () => Promise<string[]>) {
    const queue = {
      getJob: vi.fn(async () => undefined),
      addBulk: vi.fn(async (jobs: unknown[]) => jobs),
    } as unknown as Queue;
    const repo = { candidates: vi.fn(candidates) } as unknown as RecomputeRepository;
    const log = { info: vi.fn(), error: vi.fn() };
    return { queue, repo, log };
  }

  it('skips a tick while the previous scan is still running', async () => {
    let release!: (ids: string[]) => void;
    const { queue, repo, log } = fakes(() => new Promise<string[]>((r) => (release = r)));
    const scan = createRecomputeScan(queue, repo, log);

    const first = scan();
    await scan(); // overlaps the first, which has not answered yet
    release([]);
    await first;

    expect(repo.candidates).toHaveBeenCalledTimes(1);
  });

  it('logs a failed scan instead of rejecting, and runs again on the next tick', async () => {
    const { queue, repo, log } = fakes(async () => {
      throw new Error('redis is down');
    });
    const scan = createRecomputeScan(queue, repo, log);

    await expect(scan()).resolves.toBeUndefined();
    await expect(scan()).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledTimes(2);
    expect(repo.candidates).toHaveBeenCalledTimes(2);
  });

  it('logs how many runs it queued', async () => {
    const { queue, repo, log } = fakes(async () => [RUN]);
    await createRecomputeScan(queue, repo, log)();
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/queued 1 run/));
  });
});
