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
 *   - every request record feeds `run` in population `all`, and its own
 *     `request` in `all` and in its own status (`ok` or `ko`); the value is
 *     `endMs - startMs`. The run has no status populations: Gatling's report
 *     prints the run's percentiles in its Total column alone;
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
 * way back. `values` holds each key's integer milliseconds in log order;
 * `exact` holds the nearest-rank value per key at each of
 * `GATLING_PERCENTILES`, labelled the way the tool labels its output (`'50'`,
 * `'75'`, `'95'`, `'99'`).
 *
 * ═══ VALUES PER KEY, NOT LINES ═══
 *
 * The stdin text is never held whole: `gatlingMethodLines` renders it a chunk
 * at a time while the runner writes. Holding every line as a string was ALL
 * of this input's retained memory — measured at +131 MB of heap per million
 * requests, one string per line — against roughly 32 MB for the same values as
 * numbers. Key by key is the same answer as log order: each key has its own
 * digest, and the tool's contract keeps only the order of one key's values.
 */
export type GatlingMethodInput = {
  keys: Map<string, GatlingKey>;
  values: Map<string, number[]>;
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
  };

  for (const e of events) {
    if (e.type === 'request') {
      const v = observed(e.endMs - e.startMs);
      const status: GatlingPopulation = e.ok ? 'ok' : 'ko';
      const name = [...e.groups, e.name].join('/');
      // The run in `all` only: Gatling's report prints no run percentile by
      // status (its global table's percentile columns are Total alone, and no
      // detail page repeats the run), so a run OK/KO row would name a figure
      // the report never shows.
      feed('run', '', 'all', v);
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
    // A typed array sorts numerically and is dropped as soon as the ranks are read.
    const sorted = Float64Array.from(vs).sort();
    const ranked: Record<string, number> = {};
    for (const p of GATLING_PERCENTILES) ranked[String(p)] = sorted[nearestRankIndex(p, sorted.length)]!;
    exact.set(key, ranked);
  }

  return { keys, values, exact };
}

/** Lines per chunk: one `write` per line would cost a syscall each on a million-request run. */
export const GATLING_LINES_PER_CHUNK = 4096;

/**
 * The tool's stdin, rendered a chunk at a time: `k<i>\t<integer ms>` lines,
 * every chunk ending in a newline, key by key in first-seen order and each
 * key's values in log order — the only order the tool's contract keeps. A
 * generator, so a caller that writes each chunk before asking for the next
 * never holds more than one chunk of text.
 */
export function* gatlingMethodLines(
  input: Pick<GatlingMethodInput, 'values'>,
  linesPerChunk: number = GATLING_LINES_PER_CHUNK,
): Generator<string, void, undefined> {
  let chunk: string[] = [];
  for (const [key, vs] of input.values) {
    for (const v of vs) {
      chunk.push(`${key}\t${String(v)}`);
      if (chunk.length === linesPerChunk) {
        yield `${chunk.join('\n')}\n`;
        chunk = [];
      }
    }
  }
  if (chunk.length > 0) yield `${chunk.join('\n')}\n`;
}

const SCOPE_ORDER: Record<GatlingScope, number> = { run: 0, request: 1, group: 2 };
const POPULATION_ORDER: Record<GatlingPopulation, number> = { all: 0, ok: 1, ko: 2 };
const FIGURE_ORDER: Record<GatlingFigure, number> = { p50: 0, p75: 1, p95: 2, p99: 3 };

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

    const sent = input.values.get(out.key)?.length ?? 0;
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

  rows.sort(
    (a, b) =>
      SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      POPULATION_ORDER[a.population] - POPULATION_ORDER[b.population] ||
      FIGURE_ORDER[a.figure] - FIGURE_ORDER[b.figure],
  );
  return rows;
}
