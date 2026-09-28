import { describe, expect, it } from 'vitest';
import { runLabels } from '../src/charts/transforms/compare';
import { runMinuteLabel } from '../src/charts/transforms/runLabel';
import { runName, runTag } from '../src/runNumber';

/**
 * ═══ ONE SPELLING OF A RUN'S NUMBER ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * `Run 12` where a run is NAMED, `#12` where it is a compact TAG — the two
 * forms Gatling Enterprise uses, and nowhere else spelled by hand.
 */
describe('a run number, spelled', () => {
  it('names a run "Run 12" and tags it "#12"', () => {
    expect(runName(12)).toBe('Run 12');
    expect(runTag(12)).toBe('#12');
  });

  /** Two runs of one minute, both numbered: a timestamp label would need an
   *  id suffix to tell them apart; the numbers already do. */
  it('labels numbered runs by number, even when their starts share a minute', () => {
    const at = '2026-08-07T11:00:00.000Z';
    expect(
      runLabels(
        [
          { id: 'aaaaaaaa-1', at, runNumber: 4 },
          { id: 'bbbbbbbb-2', at, runNumber: 5 },
        ],
        'name',
      ),
    ).toEqual(['Run 4', 'Run 5']);
    expect(runLabels([{ id: 'aaaaaaaa-1', at, runNumber: 4 }], 'tag')).toEqual(['#4']);
  });

  /** A run with no number keeps EXACTLY today's label — and the collision
   *  suffix is decided among the numberless runs alone, so a numbered run
   *  beside them never forces one. */
  it('keeps today’s minute label for a run with no number, suffixing only real collisions', () => {
    const at = '2026-08-07T11:00:00.000Z';
    const labels = runLabels(
      [
        { id: 'aaaaaaaa-1', at, runNumber: 4 },
        { id: 'cccccccc-3', at, runNumber: null },
        { id: 'dddddddd-4', at },
      ],
      'name',
    );
    expect(labels[0]).toBe('Run 4');
    expect(labels[1]).toBe(`${runMinuteLabel(at)} · cccccc`);
    expect(labels[2]).toBe(`${runMinuteLabel(at)} · dddddd`);

    const alone = runLabels([{ id: 'eeeeeeee-5', at, runNumber: null }, { id: 'ffffffff-6', at, runNumber: 9 }], 'tag');
    expect(alone).toEqual([runMinuteLabel(at), '#9']);
  });
});
