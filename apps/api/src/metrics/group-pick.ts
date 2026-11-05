import type { ConflictException } from '@nestjs/common';
import { displayPath, requestsInGroup } from '@perfportal/contracts';
import type { MetricReader, ProjectScope, StoredMemberBucket } from '@perfportal/persistence';
import {
  DEFAULT_MAX_BUCKETS_ENDPOINT,
  mergeMemberSeries,
  type Histogram,
  type MemberBucket,
  type MergedSeries,
} from '@perfportal/statistics';
import { conflict } from '../common/validation.js';

/**
 * ═══ A GROUP READ: ITS MEMBERS, AND WHETHER THEY CAN BE MERGED EXACTLY ═══
 * (the Report pickers spec, sections 3 and 4)
 *
 * Shared by `/series` and `/distribution`, so the two endpoints cannot
 * disagree about which requests a group holds or which of them refuse a merge.
 */

/**
 * The requests `group` holds in this run, through `requestsInGroup` — the one
 * rule the Report's picker lists them by in the browser too.
 *
 * The names come from the run's own `run_stat` rows (`reader.stats`, the
 * source `/stats` serves): request-scope rows of the asked `family` for the
 * candidates, group-scope rows of any family for the run's groups. A group
 * row is filed once per family (`group_cumulated`, `group_duration`), so its
 * names are de-duplicated.
 */
export async function groupMembers(
  reader: MetricReader,
  tenant: ProjectScope,
  runId: string,
  group: string,
  family: string,
): Promise<string[]> {
  const rows = await reader.stats(tenant, runId);
  const requests = rows.filter((r) => r.scope === 'request' && r.family === family).map((r) => r.name);
  const groups = [...new Set(rows.filter((r) => r.scope === 'group').map((r) => r.name))];
  return requestsInGroup(requests, groups, group);
}

/**
 * Whether a stored histogram can take part in an exact merge: present, and
 * decoded from `sparse-ms-v2` bytes. A `sparse-ms-v1` histogram (a legacy row,
 * written before 2026-10-15) decodes NON-null with `exact === false` — its
 * observations past the 120 s cap sit in an overflow bin with no values —
 * and `Histogram.merge` carries that into its result, so merging one would
 * answer figures for a group that are not the group's. The same `.exact`
 * every other read decides by (`withExtraRanks`, `storedPercentiles`).
 * `run_series_bucket` has no kind column: the bytes are the record.
 */
export function isMergeable(h: Histogram | null): h is Histogram {
  return h !== null && h.exact;
}

/**
 * 409 GROUP_NOT_MERGEABLE: a member's stored histograms are absent or not
 * exact. Nothing is guessed — a merge without one member, or with an inexact
 * one, would draw a group the run never had. The way out is the per-request
 * read, whose stored figures need no merge.
 */
export function notMergeable(
  endpoint: 'series' | 'distribution',
  group: string,
  request: string,
): ConflictException {
  return conflict(
    'GROUP_NOT_MERGEABLE',
    `The requests of the group "${displayPath(group)}" cannot be merged exactly: "${request}" has no exact `
      + 'stored histograms (a run ingested before exact statistics, not recomputed).',
    `Read its requests one at a time with GET /v1/runs/{id}/${endpoint}?scope=request&name=<request>, `
      + 'whose stored figures need no merge.',
  );
}

/**
 * The cap this run's request series were coalesced against: its FROZEN
 * `maxBucketsEndpoint`, never the project's current setting — the engine read
 * `run.engineOptions` when it wrote these buckets, and a project changing the
 * setting since must not change how they are read. Read exactly as the engine
 * reads it (`opts.maxBucketsEndpoint ?? DEFAULT_MAX_BUCKETS_ENDPOINT`, the
 * column unvalidated), then `Number`, which coerces as `BucketSeries`'
 * `Math.max(1, cap)` does; `mergeMemberSeries` applies that floor itself.
 */
export function endpointCapOf(engineOptions: Record<string, unknown>): number {
  return Number(engineOptions['maxBucketsEndpoint'] ?? DEFAULT_MAX_BUCKETS_ENDPOINT);
}

/**
 * Every member's WHOLE series, merged into one by `mergeMemberSeries`, after
 * refusing any member bucket that cannot be merged exactly.
 *
 * The whole series, never only a window of it: the merge reads each member's
 * width off all of its offsets, and a window's worth of buckets can make a
 * coarse member look fine-grained. A caller filters the merged buckets by a
 * window afterwards, and snaps that window to `merged.widthMs` — never to a
 * width re-inferred from the merged offsets, which can disagree with it (see
 * `mergeMemberSeries`' docstring on the width).
 *
 * The refusal covers the whole series too, so a group's answer does not change
 * from 200 to 409 as a reader drags a window over the one bucket that cannot
 * be merged.
 */
export async function mergedGroupSeries(
  reader: MetricReader,
  tenant: ProjectScope,
  run: { id: string; startedOn: Date; engineOptions: Record<string, unknown> },
  members: readonly string[],
  family: string,
  endpoint: 'series' | 'distribution',
  group: string,
): Promise<MergedSeries> {
  const rows = await reader.memberSeries(tenant, run.id, run.startedOn, members, family);
  const byName = new Map<string, MemberBucket[]>();
  for (const row of rows) {
    if (!isMergeable(row.histogramOk) || !isMergeable(row.histogramKo)) throw notMergeable(endpoint, group, row.name);
    let list = byName.get(row.name);
    if (!list) { list = []; byName.set(row.name, list); }
    list.push(memberBucket(row, row.histogramOk, row.histogramKo));
  }
  return mergeMemberSeries([...byName.values()], endpointCapOf(run.engineOptions));
}

function memberBucket(row: StoredMemberBucket, histogramOk: Histogram, histogramKo: Histogram): MemberBucket {
  return {
    startOffsetMs: row.startOffsetMs,
    startedCount: row.startedCount,
    endedCount: row.endedCount,
    okCount: row.okCount,
    koCount: row.koCount,
    startedOkCount: row.startedOkCount,
    startedKoCount: row.startedKoCount,
    histogramOk,
    histogramKo,
  };
}
