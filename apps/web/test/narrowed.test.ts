import { describe, expect, it } from 'vitest';
import { narrowedLine, pickLabel, scopePhrase, withNarrowedLine, type Narrowed } from '../src/charts/transforms/narrowed';

/**
 * ═══ HOW A NARROWED CHART NAMES WHAT IT WAS NARROWED TO ═══
 *
 * `scopePhrase` is the part of a chart's empty sentence that says where it
 * looked, and `narrowedLine` is the ⓘ line that names the pick. The wording is
 * PINNED here on purpose, unlike the transforms' sentences, which are asserted
 * as claims: these are the phrases every Requests and Virtual users chart
 * shares, and the "(no group)" wording is a ruling (R9) rather than a choice
 * the next reader should re-make. A group is shown as `displayPath` shows it,
 * "(no group)" is the requests that sit in no group and never "the group
 * (no group)", and a request or scenario is shown by the name it was given.
 */

const GROUP: Narrowed = { kind: 'group', name: 'Cart' };
const NO_GROUP: Narrowed = { kind: 'group', name: '' };

describe('scopePhrase', () => {
  it.each([
    [false, null, 'in this run'],
    [true, null, 'in the selected window'],
    [false, { kind: 'request', name: 'Cart/Add To Cart' }, 'for this request'],
    [false, GROUP, 'for this group'],
    [false, { kind: 'scenario', name: 'Browse' }, 'for this scenario'],
    [true, GROUP, 'for this group in the selected window'],
    [true, { kind: 'request', name: 'Search' }, 'for this request in the selected window'],
    [false, NO_GROUP, 'for the requests in no group'],
    // The window FIRST for no group: appended, it read "…in no group in the
    // selected window", which parses as "no group in the selected window".
    [true, NO_GROUP, 'in the selected window for the requests in no group'],
  ] as const)('windowSelected=%s, narrowed=%o reads "%s"', (windowSelected, narrowed, phrase) => {
    expect(scopePhrase({ windowSelected, narrowed })).toBe(phrase);
  });

  it('reads an absent pick as no pick', () => {
    expect(scopePhrase({ windowSelected: false })).toBe('in this run');
    expect(scopePhrase({ windowSelected: true })).toBe('in the selected window');
  });

  it('never names a group for the requests in no group', () => {
    expect(scopePhrase({ windowSelected: false, narrowed: NO_GROUP })).not.toMatch(/group \(no group\)|this group/);
  });
});

describe('narrowedLine', () => {
  it('names nothing when nothing was picked', () => {
    expect(narrowedLine(null)).toBeUndefined();
    expect(narrowedLine(undefined)).toBeUndefined();
  });

  it('names a group the way the picker lists it', () => {
    expect(narrowedLine(GROUP)).toBe('Narrowed to the group Cart.');
    expect(narrowedLine({ kind: 'group', name: 'Catalog/Recommendations' })).toBe(
      'Narrowed to the group Catalog / Recommendations.',
    );
  });

  it('says the requests in no group, never "the group (no group)"', () => {
    expect(narrowedLine(NO_GROUP)).toBe('Narrowed to the requests in no group.');
    // A picker label for "(no group)" must not bring the wording back.
    expect(narrowedLine({ kind: 'group', name: '', label: '(no group)' })).toBe(
      'Narrowed to the requests in no group.',
    );
  });

  it('names a request or scenario by the name it was given', () => {
    // A request's name is shown as it is: `displayPath` splits every `/`, and a
    // top-level `/login` must not read as ` / login` (ruling R5).
    expect(narrowedLine({ kind: 'request', name: '/login' })).toBe('Narrowed to the request /login.');
    expect(narrowedLine({ kind: 'request', name: 'Cart/Add To Cart' })).toBe(
      'Narrowed to the request Cart/Add To Cart.',
    );
    expect(narrowedLine({ kind: 'scenario', name: 'Browse' })).toBe('Narrowed to the scenario Browse.');
  });

  it('shows the label it is handed in place of the derived name', () => {
    expect(narrowedLine({ kind: 'request', name: 'Cart/Add To Cart', label: 'Cart / Add To Cart' })).toBe(
      'Narrowed to the request Cart / Add To Cart.',
    );
    expect(narrowedLine({ kind: 'group', name: 'Catalog/Recommendations', label: 'Recs' })).toBe(
      'Narrowed to the group Recs.',
    );
    expect(narrowedLine({ kind: 'scenario', name: 'Browse', label: 'Browsing' })).toBe(
      'Narrowed to the scenario Browsing.',
    );
  });
});

/**
 * The pick as a short name — the ranges bar's category under a pick, where it
 * would otherwise read "All requests". The name `narrowedLine` shows, so the
 * two cannot disagree; "(no group)" has its own short form.
 */
describe('pickLabel', () => {
  it.each([
    [{ kind: 'group', name: 'Cart' }, 'Cart'],
    [{ kind: 'group', name: 'Catalog/Recommendations' }, 'Catalog / Recommendations'],
    [{ kind: 'request', name: '/login' }, '/login'],
    [{ kind: 'request', name: 'Cart/Add To Cart', label: 'Cart / Add To Cart' }, 'Cart / Add To Cart'],
    [{ kind: 'scenario', name: 'Browse' }, 'Browse'],
    [{ kind: 'group', name: '' }, 'Requests in no group'],
    [{ kind: 'group', name: '', label: '(no group)' }, 'Requests in no group'],
  ] as const)('%o is named "%s"', (narrowed, name) => {
    expect(pickLabel(narrowed)).toBe(name);
  });

  it('names the pick the way its ⓘ line does', () => {
    for (const narrowed of [
      { kind: 'group', name: 'Catalog/Recommendations' },
      { kind: 'request', name: 'Search', label: 'Search!' },
      { kind: 'scenario', name: 'Browse' },
    ] as const) {
      expect(narrowedLine(narrowed)).toBe(`Narrowed to the ${narrowed.kind} ${pickLabel(narrowed)}.`);
    }
  });
});

describe('withNarrowedLine', () => {
  it('leaves a limitation alone when nothing was picked', () => {
    expect(withNarrowedLine(undefined, null)).toBeUndefined();
    expect(withNarrowedLine(undefined, undefined)).toBeUndefined();
    expect(withNarrowedLine('Data resolution: 2000 ms.', null)).toBe('Data resolution: 2000 ms.');
  });

  it('puts the pick first, joined to whatever the chart already said', () => {
    expect(withNarrowedLine(undefined, GROUP)).toBe('Narrowed to the group Cart.');
    expect(withNarrowedLine('Data resolution: 2000 ms.', GROUP)).toBe(
      'Narrowed to the group Cart. Data resolution: 2000 ms.',
    );
  });
});
