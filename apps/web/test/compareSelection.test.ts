import { describe, expect, it } from 'vitest';
import {
  MAX_COMPARE,
  parseCompareSelection,
  serialiseCompareSelection,
} from '../src/routes/compareSelection';

/**
 * `?runs=` is the entire state of the Compare page, and it arrives from a URL
 * bar. Every id in it is used to fetch, so it is validated rather than trusted
 * — and, like `safeNext` in `paths.ts`, a bad value falls back rather than
 * refusing the reader.
 */

/** A cohort of seven, so both the cap and the membership rule have room. */
const COHORT = Array.from({ length: 7 }, (_, i) => `run-${i}`);
const CURRENT = COHORT[3]!;

describe('parseCompareSelection', () => {
  it('defaults to this run and the one before it', () => {
    // A page called Compare that opens with one run has answered nothing. The
    // cohort is newest-first, so "before" is the NEXT index — defaulting to
    // the previous index would compare a run against a NEWER one, which asks
    // the question backwards.
    expect(parseCompareSelection(null, COHORT, CURRENT)).toEqual([CURRENT, COHORT[4]]);
  });

  it('honours an explicit parameter naming only the current run', () => {
    // A reader who deselected everything gets `?runs=<current>`, which is not
    // absent — so the default must not fight them back to a pair.
    expect(parseCompareSelection(CURRENT, COHORT, CURRENT)).toEqual([CURRENT]);
    expect(parseCompareSelection('', COHORT, CURRENT)).toEqual([CURRENT]);
  });

  it('falls back to the NEWER neighbour for the oldest run in the cohort', () => {
    // The oldest run has no predecessor, and answering with nothing opens a
    // page called Compare with one run on it. The only comparison available to
    // it is against a newer run, which answers "was this ever fixed" — the
    // reason someone opens an old run from a ticket at all.
    const oldest = COHORT[COHORT.length - 1]!;
    expect(parseCompareSelection(null, COHORT, oldest)).toEqual([
      oldest,
      COHORT[COHORT.length - 2],
    ]);
  });

  it('has no default for a cohort of one, which the page explains itself', () => {
    expect(parseCompareSelection(null, ['only'], 'only')).toEqual(['only']);
  });

  it('keeps the current run first even when the URL omits it', () => {
    // This page is reached FROM a run. A selection that drops it would compare
    // a run against a set it is not in.
    const picked = parseCompareSelection(`${COHORT[0]},${COHORT[1]}`, COHORT, CURRENT);
    expect(picked[0]).toBe(CURRENT);
    expect(picked).toEqual([CURRENT, COHORT[0], COHORT[1]]);
  });

  it('keeps the current run first even when the URL puts it last', () => {
    const picked = parseCompareSelection(`${COHORT[0]},${CURRENT}`, COHORT, CURRENT);
    expect(picked).toEqual([CURRENT, COHORT[0]]);
  });

  it('drops ids outside the cohort', () => {
    // A run of a different simulation is not comparable, and the picker never
    // offers one — a hand-typed URL must not bypass that.
    const picked = parseCompareSelection(`${COHORT[0]},run-from-another-simulation`, COHORT, CURRENT);
    expect(picked).toEqual([CURRENT, COHORT[0]]);
  });

  it('collapses duplicates, keeping first-seen order', () => {
    const picked = parseCompareSelection(
      `${COHORT[1]},${COHORT[0]},${COHORT[1]}`,
      COHORT,
      CURRENT,
    );
    expect(picked).toEqual([CURRENT, COHORT[1], COHORT[0]]);
  });

  it('caps the selection', () => {
    const everything = COHORT.join(',');
    const picked = parseCompareSelection(everything, COHORT, CURRENT);
    expect(picked).toHaveLength(MAX_COMPARE);
    // The cap does not cost the current run its place.
    expect(picked[0]).toBe(CURRENT);
  });

  it('tolerates whitespace and empty segments', () => {
    const picked = parseCompareSelection(` ${COHORT[0]} , ,${COHORT[1]},`, COHORT, CURRENT);
    expect(picked).toEqual([CURRENT, COHORT[0], COHORT[1]]);
  });

  it('falls back to the current run alone on a value that is entirely junk', () => {
    // The reader asked to compare runs; a malformed query string is no reason
    // to refuse them — `safeNext`'s stance, applied here.
    expect(parseCompareSelection(',,,', COHORT, CURRENT)).toEqual([CURRENT]);
    expect(parseCompareSelection('%%%%', COHORT, CURRENT)).toEqual([CURRENT]);
  });

  it('yields nothing at all when even the current run is not in the cohort', () => {
    // Not a fabricated selection: a run that is not in the cohort it was asked
    // about cannot be compared against it, and the caller renders that state
    // rather than a chart of one unrelated run.
    expect(parseCompareSelection(null, COHORT, 'stranger')).toEqual([]);
  });

  it('round-trips a valid selection', () => {
    const picked = [CURRENT, COHORT[0]!, COHORT[5]!];
    expect(parseCompareSelection(serialiseCompareSelection(picked), COHORT, CURRENT)).toEqual(
      picked,
    );
  });
});

describe('serialiseCompareSelection', () => {
  it('is comma-separated, so the URL stays readable', () => {
    expect(serialiseCompareSelection(['a', 'b'])).toBe('a,b');
  });

  it('is empty for an empty selection, so the parameter can be dropped', () => {
    expect(serialiseCompareSelection([])).toBe('');
  });
});
