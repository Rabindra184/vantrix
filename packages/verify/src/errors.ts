import type { CanonicalEvent } from '@perfportal/core';
import type { ExpectedError, ExpectedErrorBucket, VerifyOptions } from './figures.js';
import { runSeriesWidth } from './series.js';

/**
 * ═══ `run_error` AND `run_error_bucket`, RECOMPUTED FROM THE EVENTS ═══
 *
 * Appendix A of the PR 3 plan, implemented from the text:
 *
 *   `run_error` — a label is the message, or `'(no message)'` when it is
 *   absent or empty. A non-warm-up KO request counts at `('run','')` AND at
 *   `('request', path)`; a non-warm-up error record at `('run','')` only (it
 *   names no request). Warm-up is judged by a request's START and a record's
 *   timestamp. Per `(scope, name)` the labels are ranked by count, descending,
 *   then `a.localeCompare(b)`; the first 200 keep their rows and the rest are
 *   summed into ONE row, `message ''`, `is_other`.
 *
 *   `run_error_bucket` — run scope only, KO REQUESTS only (no error record),
 *   warm-up INCLUDED, each placed by its END at the run series' width.
 *   Labels are admitted in the order first seen, up to 200; a new label after
 *   that adds only to its bucket's overflow. The top 5 admitted labels by
 *   their run-wide total (count descending, then `localeCompare`) keep their
 *   own rows; per bucket, everything else — overflow plus the non-top labels —
 *   is one `is_other` row, `message ''`, written only when it is not 0. Every
 *   row carries the width as `bucket_width_ms`.
 */

export const NO_MESSAGE = '(no message)';
/** Labels kept per `(scope, name)` in `run_error`. */
export const ERROR_ROW_CAP = 200;
/** Distinct labels the error buckets admit. */
export const ERROR_BUCKET_ADMISSION = 200;
/** Labels with rows of their own in every error bucket. */
export const ERROR_BUCKET_TOP = 5;

export function errorLabel(message: string | undefined): string {
  return message === undefined || message === '' ? NO_MESSAGE : message;
}

/** Count descending, then the label by `localeCompare` with no locale argument. */
function ranked(counts: Map<string, number>): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function bump(counts: Map<string, number>, label: string, by = 1): void {
  counts.set(label, (counts.get(label) ?? 0) + by);
}

const SCOPE_ORDER: Record<string, number> = { run: 0, request: 1 };

export function expectedErrors(events: readonly CanonicalEvent[], opts: VerifyOptions): ExpectedError[] {
  const isWarmup = (t: number): boolean => opts.warmupMs > 0 && t - opts.runStartMs < opts.warmupMs;
  const rows = new Map<string, { scope: string; name: string; counts: Map<string, number> }>();
  const add = (scope: string, name: string, label: string): void => {
    const key = `${scope}\u0000${name}`;
    let acc = rows.get(key);
    if (acc === undefined) {
      acc = { scope, name, counts: new Map() };
      rows.set(key, acc);
    }
    bump(acc.counts, label);
  };

  for (const e of events) {
    if (e.type === 'request') {
      if (e.ok || isWarmup(e.startMs)) continue;
      const label = errorLabel(e.message);
      add('run', '', label);
      add('request', [...e.groups, e.name].join('/'), label);
    } else if (e.type === 'error') {
      if (isWarmup(e.tsMs)) continue;
      add('run', '', errorLabel(e.message));
    }
  }

  const groups = [...rows.values()].sort(
    (a, b) => (SCOPE_ORDER[a.scope] ?? 9) - (SCOPE_ORDER[b.scope] ?? 9) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const out: ExpectedError[] = [];
  for (const g of groups) {
    const order = ranked(g.counts);
    for (const [message, count] of order.slice(0, ERROR_ROW_CAP)) {
      out.push({ scope: g.scope, name: g.name, message, isOther: false, count });
    }
    const rest = order.slice(ERROR_ROW_CAP);
    if (rest.length > 0) {
      out.push({ scope: g.scope, name: g.name, message: '', isOther: true, count: rest.reduce((n, [, c]) => n + c, 0) });
    }
  }
  return out;
}

export function expectedErrorBuckets(events: readonly CanonicalEvent[], opts: VerifyOptions): ExpectedErrorBucket[] {
  // The run series' width: every request's start and end edge, warm-up and
  // OK requests included, at the run cap.
  const width = runSeriesWidth(events, opts);
  if (width === null) return [];

  const totals = new Map<string, number>(); // admitted labels, in first-seen order
  const buckets = new Map<number, { counts: Map<string, number>; overflow: number }>();
  for (const e of events) {
    if (e.type !== 'request' || e.ok) continue;
    const index = Math.floor((e.endMs - opts.runStartMs) / width);
    let b = buckets.get(index);
    if (b === undefined) {
      b = { counts: new Map(), overflow: 0 };
      buckets.set(index, b);
    }
    const label = errorLabel(e.message);
    if (!totals.has(label) && totals.size >= ERROR_BUCKET_ADMISSION) {
      b.overflow += 1;
      continue;
    }
    bump(totals, label);
    bump(b.counts, label);
  }

  const top = new Set(ranked(totals).slice(0, ERROR_BUCKET_TOP).map(([label]) => label));
  const out: ExpectedErrorBucket[] = [];
  for (const index of [...buckets.keys()].sort((a, b) => a - b)) {
    const b = buckets.get(index)!;
    const startOffsetMs = index * width;
    let other = b.overflow;
    const own: ExpectedErrorBucket[] = [];
    for (const [message, count] of b.counts) {
      if (top.has(message)) own.push({ startOffsetMs, message, isOther: false, count, bucketWidthMs: width });
      else other += count;
    }
    if (other > 0) out.push({ startOffsetMs, message: '', isOther: true, count: other, bucketWidthMs: width });
    own.sort((x, y) => (x.message < y.message ? -1 : x.message > y.message ? 1 : 0));
    out.push(...own);
  }
  return out;
}
