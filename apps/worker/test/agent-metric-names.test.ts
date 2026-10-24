import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeAgentFile, parseSimulationLog } from '@perfportal/plugin-gatling';
import { buildAgentFigures, runEngine, runSeriesWidthMs } from '@perfportal/statistics';
import { AGENT_PERCENTILE_RANKS, expectedAgent, optionsFrom, runSeriesWidth } from '@perfportal/verify';
import { describe, expect, it } from 'vitest';

/**
 * ═══ THE BUILDER AND THE VERIFIER NAME THE SAME METRICS ═══
 *
 * `packages/verify` may not import `@perfportal/statistics` — not even in its
 * tests (eslint.config.js) — so the one place both implementations can be put
 * side by side without a database is here, in the worker, which depends on
 * both. On the paired fixture (one JVM's `simulation.log` and agent file) the
 * set of (metric, label) pairs each produces must be the same: a metric one
 * side spells differently, or one side files and the other does not, would
 * otherwise surface only as a run's worth of `row` mismatches.
 *
 * The values are held to each other as well — the integration case proves the
 * same through the stored rows, and this says it in a second, on the bytes.
 */

const DIR = new URL('../../../fixtures/gatling-3.15.1.2/agent-run/', import.meta.url);
const LOG = readFileSync(fileURLToPath(new URL('simulation.log', DIR)));
const AGENT = readFileSync(fileURLToPath(new URL('agent.ndjson', DIR)));

const result = runEngine(parseSimulationLog(LOG));
const opts = {
  runStartMs: result.runStartedAtMs!,
  durationMs: result.durationMs,
  bucketWidthMs: runSeriesWidthMs(result),
};
const file = decodeAgentFile(AGENT);
const built = buildAgentFigures(file, opts);
const recomputed = expectedAgent(file, opts);

const pairs = (rows: readonly { metric: string; label: string }[]): string[] =>
  [...new Set(rows.map((r) => `${r.metric}/${r.label}`))].sort();

describe('the agent builder and the verifier, on the paired fixture', () => {
  it('derive the same bucket width from simulation.log, each its own way', () => {
    const verifierWidth = runSeriesWidth(parseSimulationLog(LOG), optionsFrom({}, result.runStartedAtMs!));
    expect(verifierWidth).toBe(runSeriesWidthMs(result));
  });

  it('produce the same set of metric/label pairs', () => {
    expect(result.runStartedAtMs).not.toBeNull();
    // VACUITY: the fixture carries HTTP and machine figures, so both sides
    // must name dozens of pairs — an empty pair of sets agrees perfectly.
    expect(pairs(built.metrics).length).toBeGreaterThan(30);
    expect(pairs(recomputed.metrics)).toEqual(pairs(built.metrics));
  });

  it('produce the same metric rows, value for value', () => {
    const key = (r: { metric: string; dim: string; label: string; startOffsetMs: number; value: number }) =>
      `${r.metric}|${r.dim}|${r.label}|${r.startOffsetMs}|${r.value}`;
    expect(recomputed.metrics.map(key).sort()).toEqual(built.metrics.map(key).sort());
  });

  it('produce the same duration buckets, figure for figure', () => {
    const fromBuilder = built.durations.map((d) => ({
      key: `${d.family}|${d.dim}|${d.startOffsetMs}`,
      okCount: d.okCount,
      koCount: d.koCount,
      ok: d.histogramOk.total === 0 ? null : [d.histogramOk.min, d.histogramOk.max, d.histogramOk.sum, ...d.histogramOk.percentiles(AGENT_PERCENTILE_RANKS)],
      ko: d.histogramKo.total === 0 ? null : [d.histogramKo.min, d.histogramKo.max, d.histogramKo.sum, ...d.histogramKo.percentiles(AGENT_PERCENTILE_RANKS)],
    }));
    const fromVerifier = recomputed.durations.map((d) => ({
      key: `${d.family}|${d.dim}|${d.startOffsetMs}`,
      okCount: d.okCount,
      koCount: d.koCount,
      ok: d.ok === null ? null : [d.ok.min, d.ok.max, d.ok.sum, ...d.ok.percentiles],
      ko: d.ko === null ? null : [d.ko.min, d.ko.max, d.ko.sum, ...d.ko.percentiles],
    }));
    const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    expect(fromBuilder.length).toBeGreaterThan(0);
    expect(fromVerifier.sort(byKey)).toEqual(fromBuilder.sort(byKey));
  });
});
