import type { ToolAssertion } from '@perfportal/contracts';
import { sumUsersByOffset } from '@perfportal/statistics';
import {
  formatCount,
  formatDuration,
  formatElapsed,
  formatMs,
  formatNumber,
  formatPercent,
  formatRate,
} from './format.js';

/**
 * ═══ THE MODEL NEVER DOES ARITHMETIC ═══
 *
 * Gatling Enterprise's analysis of the run in
 * docs/superpowers/research/2026-11-02-ge-ai-run-analysis/ copied every
 * number correctly and got every number it DERIVED wrong: it added Place
 * Order's 172 failures to the 170 401s and called the 342 the cause of 289 KO;
 * it blamed the tail on the request that failed instead of the one that was
 * slow; it read the run's final drain as "a systemic functional failure
 * point". So everything a claim might rest on is computed HERE, named as a
 * fact, and the model is told to cite facts and nothing else — the number
 * check then refuses any figure that is not one of them.
 *
 * Pure: it takes rows already read and does no I/O. Deterministic: the same
 * rows produce the same facts in the same order, so a stored analysis can be
 * checked against the facts it was given.
 */

/**
 * Bumped whenever a fact's id, meaning or rendering changes. Stored beside the
 * analysis as a RECORD of which facts it was checked against — never as a
 * staleness signal: a bump does not make a stored analysis stale (the spec's
 * section 4, and `isStale` in the API), because an upgrade must not invite
 * paid regeneration across an install.
 */
export const FACTS_VERSION = 1;

/**
 * One citable figure.
 *
 * `display` is the form the model must write, from `format.ts`; `value` is the
 * unrounded number behind it (a percentage for a percent fact — 16.76…, not
 * 0.1676…), or null for a fact that is words. `text` carries the words: a
 * request's name, an error's message, an assertion's expression.
 */
export interface Fact {
  id: string;
  label: string;
  display: string;
  value: number | null;
  text: string | null;
}

export interface RunFacts {
  version: number;
  facts: Fact[];
}

/*
 * ═══ THE STORED FIGURES, AS THIS PACKAGE READS THEM ═══
 *
 * The worker hands in `readStoredFigures`' result. This package may not import
 * @perfportal/persistence — it is pure, and that package is the database — so
 * it declares the fields it reads and nothing more. Persistence's
 * `StoredFigures` is assignable to `FactsFigures` (the test pins it), so a
 * field renamed there fails to compile at the worker's call rather than
 * reading as `undefined` here.
 */

export interface FactsFigureStat {
  scope: string;
  name: string;
  family: string;
  count: number;
  okCount: number;
  koCount: number;
  /** A FRACTION, `koCount / count`, as stored. */
  errorRate: number;
  maxMs: number;
  meanMs: number;
  stddevMs: number;
  throughputRps: number;
  percentiles: Record<string, number>;
}

export interface FactsFigureSeriesBucket {
  scope: string;
  name: string;
  family: string;
  startOffsetMs: number;
  okCount: number;
  koCount: number;
}

export interface FactsFigureError {
  scope: string;
  name: string;
  message: string;
  isOther: boolean;
  count: number;
}

export interface FactsFigureUserBucket {
  scenario: string;
  startOffsetMs: number;
  started: number;
  ended: number;
  maxConcurrent: number;
}

export interface FactsFigures {
  stats: FactsFigureStat[];
  seriesBuckets: FactsFigureSeriesBucket[];
  errors: FactsFigureError[];
  userBuckets: FactsFigureUserBucket[];
}

export interface FactsInput {
  run: { simulation: string | null; status: string; durationMs: number | null; activityMs: number | null };
  figures: FactsFigures;
  /**
   * The platform's SLA assertions, already described and rendered by the
   * caller. `threshold` is the rule's bound as the run page writes it
   * (`formatSlaBound`) and the number in front of its unit; null when the
   * frozen rule could not be read.
   */
  platformAssertions: {
    description: string;
    outcome: string;
    actualDisplay: string | null;
    threshold: { display: string; value: number } | null;
  }[];
  toolAssertions: ToolAssertion[];
}

/*
 * ═══ THE BOUNDS ═══
 *
 * A run can name hundreds of requests, and a prompt carrying seven facts for
 * each is a prompt nobody pays for. The busiest twenty get their facts, and so
 * does every request a derived fact names — the model must be able to cite
 * the tail's owner's own figures even when it ran rarely, which is precisely
 * the run where it matters.
 */

/** How many requests (and, separately, groups) get their own facts. */
export const REQUEST_FACT_LIMIT = 20;
/** How many error messages are stated one by one; the rest fold into "Other errors". */
export const ERROR_FACT_LIMIT = 20;
/** How many requests' KO are stated one by one; the rest fold into one part. */
export const KO_PART_LIMIT = 20;
/** How many names `derived.alwaysFailed` lists before "and N more". */
export const NAME_LIST_LIMIT = 20;
/**
 * How many assertions of each kind (platform, simulation) are stated one by
 * one. A simulation's `forAll` assertion expands to a row per request, so a
 * wide run can carry hundreds; every kind also carries its outcome counts, so
 * what is left out is still counted.
 */
export const ASSERTION_FACT_LIMIT = 20;

/**
 * The scope and family a row is read from, as the statistics table reads
 * them: requests and the run under `response_time`, a group under
 * `group_cumulated` — the family whose figures Gatling's own global table
 * shows (`StatisticsTable`'s GLOBAL_GROUP_FAMILY, settled by measurement
 * there). `group_duration` is the group's wall-clock span and is a different
 * number for the same name.
 */
const RUN_FAMILY = 'response_time';
const GROUP_FAMILY = 'group_cumulated';

/** The remainder of the error table, rendered as the Errors table renders it. */
const OTHER_ERRORS = 'Other errors';

function numeric(id: string, label: string, display: string, value: number): Fact {
  return { id, label, display, value, text: null };
}

function words(id: string, label: string, text: string): Fact {
  return { id, label, display: text, value: null, text };
}

/**
 * Code-unit order, not `localeCompare`: that one follows the host's locale,
 * and the same rows must produce the same facts on every worker.
 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Busiest first, then by name, so a tie never depends on the order rows arrived in. */
function byCount(a: FactsFigureStat, b: FactsFigureStat): number {
  return b.count - a.count || compareText(a.name, b.name);
}

function percentile(row: FactsFigureStat, key: string): number | null {
  const v = row.percentiles[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const OUTCOME_WORD: Record<string, string> = {
  passed: 'passed',
  failed: 'failed',
  not_applicable: 'not applicable',
};

const outcomeWord = (outcome: string): string => OUTCOME_WORD[outcome] ?? outcome;

/**
 * A Gatling assertion's actual in the unit its target implies — the same
 * reading `toolAssertionParts` gives the run page: a response time in ms, a
 * percentage as a percentage (the engine stores 83.23…, never 0.83), a count
 * as a count. GE printed "83.23665893271462%"; this never does.
 */
function formatToolActual(a: ToolAssertion): string | null {
  return a.actualValue === null ? null : formatInTargetUnit(a, a.actualValue);
}

/** A number in the unit an assertion's target implies: its actual, or a bound of its condition. */
function formatInTargetUnit(a: ToolAssertion, v: number): string {
  switch (a.assertion?.target.kind) {
    case 'responseTime':
      return formatMs(v);
    case 'percent':
      return formatPercent(v / 100);
    case 'count':
      return formatCount(v);
    case 'meanRequestsPerSecond':
      return formatRate(v);
    default:
      return formatNumber(v);
  }
}

/** The seven facts every request (and group) carries, under `<kind>.<i>`. */
function rowFacts(kind: 'request' | 'group', i: number, row: FactsFigureStat): Fact[] {
  const p = `${kind}.${i}`;
  const n = row.name;
  const out: Fact[] = [
    words(`${p}.name`, `${kind === 'request' ? 'Request' : 'Group'} ${i + 1}`, n),
    numeric(`${p}.count`, `${n}: count`, formatCount(row.count), row.count),
    numeric(`${p}.ko`, `${n}: KO`, formatCount(row.koCount), row.koCount),
    numeric(`${p}.errorRate`, `${n}: error rate`, formatPercent(row.errorRate), row.errorRate * 100),
  ];
  const p95 = percentile(row, 'p95');
  if (p95 !== null) out.push(numeric(`${p}.p95`, `${n}: p95`, formatMs(p95), p95));
  const p99 = percentile(row, 'p99');
  if (p99 !== null) out.push(numeric(`${p}.p99`, `${n}: p99`, formatMs(p99), p99));
  out.push(numeric(`${p}.max`, `${n}: max`, formatMs(row.maxMs), row.maxMs));
  return out;
}

function runFacts(input: FactsInput, run: FactsFigureStat | undefined): Fact[] {
  const out: Fact[] = [];
  if (input.run.simulation !== null) out.push(words('run.simulation', 'Simulation', input.run.simulation));
  out.push(words('run.status', 'Run status', input.run.status));
  if (run !== undefined) {
    out.push(
      numeric('run.requests', 'Requests', formatCount(run.count), run.count),
      numeric('run.ok', 'OK', formatCount(run.okCount), run.okCount),
      numeric('run.ko', 'KO', formatCount(run.koCount), run.koCount),
      numeric('run.errorRate', 'Error rate', formatPercent(run.errorRate), run.errorRate * 100),
      numeric('run.throughput', 'Throughput', formatRate(run.throughputRps), run.throughputRps),
    );
  }
  // The Duration chip's own choice: the activity span where the run has one,
  // so the fact and the header beside the analysis cannot disagree.
  const duration = input.run.activityMs ?? input.run.durationMs;
  if (duration !== null) out.push(numeric('run.duration', 'Duration', formatDuration(duration), duration));

  const users = sumUsersByOffset(input.figures.userBuckets);
  if (users.length > 0) {
    const peak = Math.max(...users.map((u) => u.maxConcurrent));
    out.push(numeric('run.peakUsers', 'Peak users', formatCount(peak), peak));
  }
  if (run !== undefined) {
    out.push(numeric('run.mean', 'Mean response time', formatMs(run.meanMs), run.meanMs));
    for (const key of ['p50', 'p95', 'p99'] as const) {
      const v = percentile(run, key);
      if (v !== null) out.push(numeric(`run.${key}`, `${key} response time`, formatMs(v), v));
    }
    out.push(
      numeric('run.max', 'Max response time', formatMs(run.maxMs), run.maxMs),
      numeric('run.stddev', 'Standard deviation', formatMs(run.stddevMs), run.stddevMs),
    );
  }
  return out;
}

/**
 * ═══ SHARES ARE OF RECORDED ERRORS, NEVER OF REQUESTS ═══
 *
 * The Errors table's own figure: each message's share of the run's recorded
 * errors, which may EXCEED its KO — Gatling records standalone errors that
 * belong to no request. GE wrote "170 occurrences (9.86% of requests)", a
 * figure no PerfPortal page shows; the facts never define one a second way.
 * Run scope only, as the table reads it: a request-scoped copy of a message
 * would count it twice.
 */
function errorFacts(errors: FactsFigureError[]): Fact[] {
  const rows = errors.filter((e) => e.scope === 'run');
  const total = rows.reduce((s, e) => s + e.count, 0);
  const out: Fact[] = [numeric('errors.total', 'Recorded errors', formatCount(total), total)];

  const named = rows
    .filter((e) => !e.isOther)
    .sort((a, b) => b.count - a.count || compareText(a.message, b.message));
  const listed: { message: string; count: number }[] = named.slice(0, ERROR_FACT_LIMIT);
  const folded =
    named.slice(ERROR_FACT_LIMIT).reduce((s, e) => s + e.count, 0) +
    rows.filter((e) => e.isOther).reduce((s, e) => s + e.count, 0);
  const hasOther = rows.some((e) => e.isOther) || named.length > ERROR_FACT_LIMIT;
  if (hasOther) listed.push({ message: OTHER_ERRORS, count: folded });

  listed.forEach((e, i) => {
    const share = total > 0 ? e.count / total : 0;
    out.push(
      words(`error.${i}.message`, `Error ${i + 1}`, e.message),
      numeric(`error.${i}.count`, `${e.message}: count`, formatCount(e.count), e.count),
      numeric(`error.${i}.share`, `${e.message}: share of recorded errors`, formatPercent(share), share * 100),
    );
  });
  return out;
}

/** Each outcome's count, for one kind of assertion, so a bounded list still says how many there were. */
function outcomeCountFacts(kind: 'platform' | 'tool', noun: string, outcomes: string[]): Fact[] {
  const count = (o: string): number => outcomes.filter((x) => x === o).length;
  const p = `assertions.${kind}`;
  return [
    numeric(`${p}.total`, `${noun}s`, formatCount(outcomes.length), outcomes.length),
    numeric(`${p}.failed`, `${noun}s failed`, formatCount(count('failed')), count('failed')),
    numeric(`${p}.passed`, `${noun}s passed`, formatCount(count('passed')), count('passed')),
    numeric(`${p}.notApplicable`, `${noun}s not applicable`, formatCount(count('not_applicable')), count('not_applicable')),
  ];
}

/**
 * The indices of the assertions stated one by one: every failure first, then
 * the rest in their own order, up to `ASSERTION_FACT_LIMIT`, returned in index
 * order. A failure is what an analysis has to be able to cite; the passes fill
 * whatever room is left, so a run with a handful keeps all of them.
 */
function shownAssertions(outcomes: string[]): number[] {
  const indices = outcomes.map((_, i) => i);
  const failed = indices.filter((i) => outcomes[i] === 'failed');
  const rest = indices.filter((i) => outcomes[i] !== 'failed');
  return [...failed, ...rest].slice(0, ASSERTION_FACT_LIMIT).sort((a, b) => a - b);
}

/**
 * ═══ AN ASSERTION'S ID IS ITS POSITION IN THE RUN'S OWN LIST ═══
 *
 * `assertion.platform.<i>` and `assertion.tool.<i>` keep the index the run
 * stores the assertion at, not its place among the ones shown, so the same
 * assertion has the same id whether or not the cap left others out.
 *
 * A bound gets a fact of its own — "its 800 ms limit" is a number the model
 * needs and the description carries only inside a whole sentence. A platform
 * bound is the run page's own rendering (`formatSlaBound`); a simulation
 * assertion's is its condition's number in its target's unit, where the
 * condition has one (`between` has two).
 */
function assertionFacts(input: FactsInput): Fact[] {
  const out: Fact[] = [];
  const platform = input.platformAssertions;
  if (platform.length > 0) out.push(...outcomeCountFacts('platform', 'Platform assertion', platform.map((a) => a.outcome)));
  for (const i of shownAssertions(platform.map((a) => a.outcome))) {
    const a = platform[i];
    if (a === undefined) continue;
    const actual = a.actualDisplay === null ? '' : ` · ${a.actualDisplay}`;
    out.push({
      id: `assertion.platform.${i}`,
      label: `Platform assertion ${i + 1}`,
      display: `${outcomeWord(a.outcome)}${actual}`,
      value: null,
      text: a.description,
    });
    if (a.threshold !== null) {
      out.push(numeric(`assertion.platform.${i}.threshold`, `Platform assertion ${i + 1}: limit`, a.threshold.display, a.threshold.value));
    }
  }

  const tool = input.toolAssertions;
  if (tool.length > 0) out.push(...outcomeCountFacts('tool', 'Simulation assertion', tool.map((a) => a.outcome)));
  for (const i of shownAssertions(tool.map((a) => a.outcome))) {
    const a = tool[i];
    if (a === undefined) continue;
    const actual = formatToolActual(a);
    out.push({
      id: `assertion.tool.${i}`,
      label: `Simulation assertion ${i + 1}`,
      display: `${outcomeWord(a.outcome)}${actual === null ? '' : ` · ${actual}`}`,
      value: a.actualValue,
      text: a.expression,
    });
    out.push(...toolBoundFacts(a, i));
  }
  return out;
}

/** A simulation assertion's bound: its condition's number, or a `between`'s two. */
function toolBoundFacts(a: ToolAssertion, i: number): Fact[] {
  const condition = a.assertion?.condition;
  if (condition === undefined) return [];
  const label = `Simulation assertion ${i + 1}`;
  const bound = (suffix: string, what: string, v: number | undefined): Fact[] =>
    typeof v === 'number' && Number.isFinite(v)
      ? [numeric(`assertion.tool.${i}.${suffix}`, `${label}: ${what}`, formatInTargetUnit(a, v), v)]
      : [];
  return [
    ...bound('threshold', 'limit', condition.value),
    ...bound('thresholdLow', 'lower limit', condition.lo),
    ...bound('thresholdHigh', 'upper limit', condition.hi),
  ];
}

/** The first request (in count order) with the strictly largest percentile `key`. */
function largestBy(requests: FactsFigureStat[], key: string): { row: FactsFigureStat; value: number } | null {
  let best: { row: FactsFigureStat; value: number } | null = null;
  for (const row of requests) {
    const v = percentile(row, key);
    if (v !== null && (best === null || v > best.value)) best = { row, value: v };
  }
  return best;
}

/**
 * ═══ DID OK FALL TO ZERO, AND WHEN ═══
 *
 * A bucket whose responses were ALL failures. GE saw OK reach zero in the last
 * seconds of the run and called it a failure point; it was the run's drain,
 * when the only requests left were each user's last step, Place Order, which
 * failed every time. So the fact says which it was:
 *
 * "Final drain" means every zero-OK bucket starts at or after the END of the
 * last users bucket in which a user started — nothing new was arriving, only
 * stragglers finishing. One zero-OK bucket before that is "during the run".
 *
 * ═══ THE END OF THAT BUCKET, NOT ITS START — AND PER SCENARIO ═══
 *
 * Users and response-time buckets coalesce on independent caps ("two series,
 * two widths"), so on a long run a users bucket can be wider than a series
 * bucket. Users 2 s wide whose last arrivals bucket starts at 84 s cover
 * arrivals up to 86 s, and a zero-OK series bucket at 85 s starts after 84 s
 * while users are still arriving. A users bucket's end is the next bucket's
 * start; when no bucket follows it, where arrivals ended is unknown.
 *
 * Each SCENARIO coalesces on its own schedule too, so two scenarios can hold
 * two widths at once. Read off the summed "All users" series, a narrow
 * scenario's buckets interleave with a wide one's, and the "next" offset after
 * the wide scenario's last arrivals is the narrow one's — inside the bucket the
 * wide scenario was still arriving in. So the end is found per scenario (the
 * start of the bucket that follows its last one with arrivals, in its OWN
 * series), and arrivals ended at the LATEST of those ends.
 *
 * Every missing piece of evidence reads "during the run" — no users series, or
 * any scenario with arrivals whose last arrivals bucket has none after it:
 * the fact never claims the reassuring reading on missing evidence.
 *
 * A bucket with no responses at all is not OK falling to zero — nothing was
 * answered, so nothing failed. Run scope only.
 */
/**
 * When the last user arrived, as the latest of each scenario's own end of
 * arrivals; undefined when no scenario started anyone, or when any scenario's
 * last arrivals bucket is its last bucket (its end is unknown).
 */
function latestArrivalsEnd(rows: FactsFigureUserBucket[]): number | undefined {
  const byScenario = new Map<string, FactsFigureUserBucket[]>();
  for (const r of rows) byScenario.set(r.scenario, [...(byScenario.get(r.scenario) ?? []), r]);

  let latest: number | undefined;
  for (const buckets of byScenario.values()) {
    const sorted = [...buckets].sort((a, b) => a.startOffsetMs - b.startOffsetMs);
    let last = -1;
    sorted.forEach((b, i) => {
      if (b.started > 0) last = i;
    });
    if (last === -1) continue; // nobody arrived in this scenario: it bounds nothing
    const end = sorted[last + 1]?.startOffsetMs;
    if (end === undefined) return undefined;
    if (latest === undefined || end > latest) latest = end;
  }
  return latest;
}

function okZeroFact(figures: FactsFigures): Fact | null {
  const zeros = figures.seriesBuckets
    .filter((b) => b.scope === 'run' && b.family === RUN_FAMILY && b.okCount === 0 && b.koCount > 0)
    .sort((a, b) => a.startOffsetMs - b.startOffsetMs);
  const first = zeros[0];
  if (first === undefined) return null;

  const arrivalsEnd = latestArrivalsEnd(figures.userBuckets);
  const drain = arrivalsEnd !== undefined && zeros.every((b) => b.startOffsetMs >= arrivalsEnd);
  return {
    id: 'derived.okZero',
    label: 'OK responses fell to zero',
    display: formatElapsed(first.startOffsetMs),
    value: first.startOffsetMs,
    text: drain ? 'only in the final drain' : 'during the run',
  };
}

/** Facts computed here so the model never derives them; and the names they mention. */
function derivedFacts(
  requests: FactsFigureStat[],
  run: FactsFigureStat | undefined,
  figures: FactsFigures,
): { facts: Fact[]; named: Set<string> } {
  const facts: Fact[] = [];
  const named = new Set<string>();

  // Every response failed: a request that never once succeeded.
  const always = requests.filter((r) => r.count > 0 && r.okCount === 0);
  if (always.length > 0) {
    const shown = always.slice(0, NAME_LIST_LIMIT);
    for (const r of shown) named.add(r.name);
    const more = always.length - shown.length;
    const text = shown.map((r) => r.name).join(', ') + (more > 0 ? `, and ${more} more` : '');
    facts.push({
      id: 'derived.alwaysFailed',
      label: 'Requests whose every response failed',
      display: formatCount(always.length),
      value: always.length,
      text,
    });
  }

  // KO by request, so the parts SUM to the run's KO — GE's 342-against-289.
  const failing = requests
    .filter((r) => r.koCount > 0)
    .sort((a, b) => b.koCount - a.koCount || compareText(a.name, b.name));
  failing.slice(0, KO_PART_LIMIT).forEach((r, i) => {
    named.add(r.name);
    facts.push({ id: `derived.koByRequest.${i}`, label: `KO of ${r.name}`, display: formatCount(r.koCount), value: r.koCount, text: r.name });
  });
  const rest = failing.slice(KO_PART_LIMIT);
  if (rest.length > 0) {
    const sum = rest.reduce((s, r) => s + r.koCount, 0);
    const text = `${rest.length} other requests`;
    facts.push({ id: 'derived.koByRequest.other', label: `KO of ${text}`, display: formatCount(sum), value: sum, text });
  }

  // The tail's owner is the request that holds the run's MAXIMUM — read off
  // the figure, never inferred from which request failed.
  if (run !== undefined) {
    const owner = requests.find((r) => r.maxMs === run.maxMs);
    if (owner !== undefined) {
      named.add(owner.name);
      facts.push({
        id: 'derived.tailOwner',
        label: 'Request holding the run’s max response time',
        display: formatMs(owner.maxMs),
        value: owner.maxMs,
        text: owner.name,
      });
    }
  }
  const p99 = largestBy(requests, 'p99');
  if (p99 !== null) {
    named.add(p99.row.name);
    facts.push({ id: 'derived.p99Owner', label: 'Request with the largest p99', display: formatMs(p99.value), value: p99.value, text: p99.row.name });
  }
  const p95 = largestBy(requests, 'p95');
  if (p95 !== null) {
    named.add(p95.row.name);
    facts.push({ id: 'derived.slowestP95', label: 'Slowest request by p95', display: formatMs(p95.value), value: p95.value, text: p95.row.name });
  }

  const okZero = okZeroFact(figures);
  if (okZero !== null) facts.push(okZero);
  return { facts, named };
}

export function buildRunFacts(input: FactsInput): RunFacts {
  const { stats } = input.figures;
  // No run-scope row is refused upstream; here it only means the run facts
  // are missing, and whatever else the rows support is still stated.
  const run = stats.find((s) => s.scope === 'run' && s.family === RUN_FAMILY);
  const requests = stats.filter((s) => s.scope === 'request' && s.family === RUN_FAMILY).sort(byCount);
  const groups = stats.filter((s) => s.scope === 'group' && s.family === GROUP_FAMILY).sort(byCount);

  const derived = derivedFacts(requests, run, input.figures);
  const shown = requests.filter((r, i) => i < REQUEST_FACT_LIMIT || derived.named.has(r.name));

  return {
    version: FACTS_VERSION,
    facts: [
      ...runFacts(input, run),
      ...shown.flatMap((r, i) => rowFacts('request', i, r)),
      ...groups.slice(0, REQUEST_FACT_LIMIT).flatMap((g, i) => rowFacts('group', i, g)),
      ...errorFacts(input.figures.errors),
      ...assertionFacts(input),
      ...derived.facts,
    ],
  };
}
