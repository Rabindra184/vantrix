import type { Window } from '@perfportal/contracts';
import type { MetricReader } from '@perfportal/persistence';
import { inferBucketWidthMs } from '@perfportal/statistics';
import { badRequest, parseRange } from './validation.js';

/**
 * Parses `?from=&to=`, and refuses it for a run that cannot answer it.
 *
 * ═══ SHARED SO THE GUARD CANNOT BE FORGOTTEN ON ONE ENDPOINT ═══
 *
 * Six endpoints take a range. If the `WINDOW_UNAVAILABLE` check lived in each
 * of them, forgetting it in one would let a brushed page show five windowed
 * figures beside one whole-run figure — with nothing on screen saying which
 * was which, and every number individually defensible.
 *
 * Returns null when neither bound was sent, which means the whole run and
 * skips the availability query entirely.
 */
export async function resolveRange(
  reader: MetricReader,
  run: { id: string; orgId: string; projectId: string; startedOn: Date },
  from: string | undefined,
  to: string | undefined,
): Promise<{ fromMs: number; toMs: number } | null> {
  const range = parseRange(from, to);
  if (range === null) return null;

  const windowable = await reader.isWindowable(
    { orgId: run.orgId, projectId: run.projectId }, run.id, run.startedOn,
  );
  if (!windowable) {
    // 400, not whole-run numbers. Serving the full run under a windowed
    // request would be the silently-ignored-parameter failure in its most
    // damaging form: a page that looks brushed and is not.
    throw badRequest(
      'WINDOW_UNAVAILABLE',
      'This run was ingested before per-bucket histograms were recorded, so it cannot be re-aggregated over a time window.',
      'Re-ingest the run to enable time-window analysis, or request the whole run by omitting "from" and "to".',
    );
  }
  return range;
}

/**
 * Snaps a requested range OUTWARD to bucket boundaries.
 *
 * Outward, never inward: nothing the reader selected may fall outside the
 * answer. The upper edge also stops at the last bucket that exists, so a window
 * dragged past the end of a run reports the run's extent rather than a range
 * with no data behind half of it.
 *
 * ONE RULE FOR EVERY ENDPOINT. Six responses carry a `window`, and a page that
 * snapped its chart one way and its table another would put two different
 * elapsed ranges on one screen under one heading.
 */
export function snapWindow(
  offsets: readonly number[],
  range: { fromMs: number; toMs: number },
): Window {
  // The width comes from the OFFSETS THEMSELVES, never a 1000ms constant: the
  // engine halves resolution on a long run, and assuming 1000 would scale
  // every rate by a power of two with nothing looking wrong.
  const bucketWidthMs = inferBucketWidthMs([...offsets].sort((a, b) => a - b));
  const fromMs = Math.floor(range.fromMs / bucketWidthMs) * bucketWidthMs;
  const last = offsets.length === 0 ? fromMs : Math.max(...offsets);
  const toMs = Math.min(
    Math.ceil(range.toMs / bucketWidthMs) * bucketWidthMs,
    last + bucketWidthMs,
  );
  // A range entirely past the end of the run still has to describe a non-empty
  // span, or WindowSchema's positive `toMs` rejects the response.
  return { fromMs, toMs: Math.max(toMs, fromMs + bucketWidthMs), bucketWidthMs };
}

/** Half-open, matching WINDOWED_BUCKETS_SQL: `>= from AND < to`, so two
 *  adjacent windows never both claim the boundary bucket. */
export const inRange = (
  offset: number,
  range: { fromMs: number; toMs: number } | null,
): boolean => range === null || (offset >= range.fromMs && offset < range.toMs);
