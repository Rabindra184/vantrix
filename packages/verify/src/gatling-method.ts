import type { CanonicalEvent } from '@perfportal/core';
import { nearestRankIndex } from './rank.js';

/**
 * ═══ WHAT GATLING'S OWN REPORT WOULD PRINT, AND WHERE IT DIFFERS ═══
 *
 * Two pure halves around the Gatling-method tool (tools/gatling-method): one
 * builds the tool's stdin from a run's decoded events, the other turns the
 * tool's stdout into the rows where Gatling's report and the exact value at a
 * rank disagree. The process in between is the worker's; this package stays
 * pure (independence.test.ts).
 *
 * Gatling's stats keys, each fed in log order:
 *
 *   - every request record feeds `run` and its own `request`, each in
 *     population `all` and in its own status (`ok` or `ko`); the value is
 *     `endMs - startMs`;
 *   - every group record feeds its own `group` with its CUMULATED response
 *     time — never its duration (spec amendment 2: every group cell of two real
 *     reports lies inside the cumulated replay, and outside the duration one).
 *
 * Every request counts, warm-up included: Gatling knows no warm-up, and this
 * takes no engine options at all, so there is nothing that could drop one
 * (amendment 4). `exact` is nearest rank over exactly the same values.
 *
 * Names are the STORED identity — path segments joined with `/`, unspaced —
 * spelled the way `expectedFrom` spells `run_stat.name`. Gatling's report
 * spaces them (`Cart / Add To Cart`); that spelling belongs to the report, not
 * to a row this product stores.
 *
 * Values go through the same normalisation `expectedFrom` applies to every
 * observation — `Math.max(0, Math.round(v))` — so an `exact` here agrees with
 * the stored figure for the same rank, and the tool is handed the integer
 * milliseconds its line protocol requires.
 */

export const GATLING_PERCENTILES = [50, 75, 95, 99] as const;

export type GatlingScope = 'run' | 'request' | 'group';
export type GatlingPopulation = 'all' | 'ok' | 'ko';
export type GatlingFigure = 'p50' | 'p75' | 'p95' | 'p99';

export type GatlingKey = { scope: GatlingScope; name: string; population: GatlingPopulation };

/**
 * The tool's stdin, and what each line means.
 *
 * `keys` maps an OPAQUE key — `k0`, `k1`, … in first-seen order — to what it
 * stands for. Only the opaque key crosses the process boundary, so no request
 * name can break the tab-and-newline line protocol or need JSON escaping on the
 * way back. `lines` are `k<i>\t<integer ms>` in log order; `exact` holds the
 * nearest-rank value per key at each of `GATLING_PERCENTILES`, labelled the way
 * the tool labels its output (`'50'`, `'75'`, `'95'`, `'99'`).
 */
export type GatlingMethodInput = {
  keys: Map<string, GatlingKey>;
  lines: string[];
  exact: Map<string, Record<string, number>>;
};

/** One line of the tool's stdout: `{"key":"k3","n":160,"p":{"50":[551,551],…}}`. */
export type GatlingMethodOutput = { key: string; n: number; p: Record<string, [number, number]> };

export type GatlingDifference = {
  scope: GatlingScope;
  name: string;
  population: GatlingPopulation;
  figure: GatlingFigure;
  gatlingLow: number;
  gatlingHigh: number;
  exact: number;
};

/** Every observation is a whole, non-negative millisecond count — as in `expectedFrom`. */
function observed(v: number): number {
  return Math.max(0, Math.round(v));
}

export function gatlingMethodInput(events: Iterable<CanonicalEvent>): GatlingMethodInput {
  const keys = new Map<string, GatlingKey>();
  const values = new Map<string, number[]>();
  const index = new Map<string, string>();
  const lines: string[] = [];

  const feed = (scope: GatlingScope, name: string, population: GatlingPopulation, value: number): void => {
    // A private lookup key; the NUL cannot occur in a name, so it cannot collide.
    const identity = `${scope}\u0000${name}\u0000${population}`;
    let key = index.get(identity);
    if (key === undefined) {
      key = `k${String(index.size)}`;
      index.set(identity, key);
      keys.set(key, { scope, name, population });
      values.set(key, []);
    }
    values.get(key)!.push(value);
    lines.push(`${key}\t${String(value)}`);
  };

  for (const e of events) {
    if (e.type === 'request') {
      const v = observed(e.endMs - e.startMs);
      const status: GatlingPopulation = e.ok ? 'ok' : 'ko';
      const name = [...e.groups, e.name].join('/');
      feed('run', '', 'all', v);
      feed('run', '', status, v);
      feed('request', name, 'all', v);
      feed('request', name, status, v);
    } else if (e.type === 'group') {
      const v = observed(e.cumulatedResponseTimeMs);
      const status: GatlingPopulation = e.ok ? 'ok' : 'ko';
      const path = e.groups.join('/');
      feed('group', path, 'all', v);
      feed('group', path, status, v);
    }
  }

  const exact = new Map<string, Record<string, number>>();
  for (const [key, vs] of values) {
    const sorted = [...vs].sort((a, b) => a - b);
    const ranked: Record<string, number> = {};
    for (const p of GATLING_PERCENTILES) ranked[String(p)] = sorted[nearestRankIndex(p, sorted.length)]!;
    exact.set(key, ranked);
  }

  return { keys, lines, exact };
}

const SCOPE_ORDER: Record<GatlingScope, number> = { run: 0, request: 1, group: 2 };
const POPULATION_ORDER: Record<GatlingPopulation, number> = { all: 0, ok: 1, ko: 2 };

/** The number of lines each key was sent, read off the lines themselves. */
function countsOf(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = line.slice(0, line.lastIndexOf('\t'));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * One row per (key, percentile) where Gatling's range is not exactly the exact
 * value: `gatlingLow !== exact || gatlingHigh !== exact`.
 *
 * THROWS rather than dropping, on every disagreement about WHAT was answered:
 * a key the input never produced, a key it produced that the tool left out, a
 * key answered twice, a count other than the values sent, a percentile missing
 * from a row. Each is a defect in the tool or in the plumbing to it, and a
 * silent drop would read as "Gatling agrees" for exactly the keys nobody
 * compared.
 */
export function gatlingDifferences(input: GatlingMethodInput, output: GatlingMethodOutput[]): GatlingDifference[] {
  const counts = countsOf(input.lines);
  const answered = new Set<string>();
  const rows: GatlingDifference[] = [];

  for (const out of output) {
    const key = input.keys.get(out.key);
    const exact = input.exact.get(out.key);
    if (key === undefined || exact === undefined) {
      throw new Error(`Gatling-method answered for key ${out.key}, which was never sent to it.`);
    }
    if (answered.has(out.key)) throw new Error(`Gatling-method answered for key ${out.key} twice.`);
    answered.add(out.key);

    const sent = counts.get(out.key) ?? 0;
    if (out.n !== sent) {
      throw new Error(`Gatling-method counted ${String(out.n)} values for key ${out.key}; ${String(sent)} were sent.`);
    }

    for (const p of GATLING_PERCENTILES) {
      const label = String(p);
      const range = out.p[label];
      const value = exact[label];
      if (range === undefined || value === undefined) {
        throw new Error(`Gatling-method gave no ${label}th percentile for key ${out.key}.`);
      }
      const [gatlingLow, gatlingHigh] = range;
      if (gatlingLow !== value || gatlingHigh !== value) {
        rows.push({
          scope: key.scope,
          name: key.name,
          population: key.population,
          figure: `p${label}` as GatlingFigure,
          gatlingLow,
          gatlingHigh,
          exact: value,
        });
      }
    }
  }

  const missing = [...input.keys.keys()].filter((k) => !answered.has(k));
  if (missing.length > 0) {
    throw new Error(`Gatling-method left out ${String(missing.length)} key(s): ${missing.join(', ')}.`);
  }

  const FIGURE_ORDER: Record<GatlingFigure, number> = { p50: 0, p75: 1, p95: 2, p99: 3 };
  rows.sort(
    (a, b) =>
      SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      POPULATION_ORDER[a.population] - POPULATION_ORDER[b.population] ||
      FIGURE_ORDER[a.figure] - FIGURE_ORDER[b.figure],
  );
  return rows;
}
