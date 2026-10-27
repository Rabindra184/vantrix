import {
  AGENT_PERCENTILE_ROWS,
  AgentConnectionsResponseSchema,
  AgentDnsResponseSchema,
  roundForReading,
} from '@perfportal/contracts';
import type { DurationSection } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { expectAboutTheRun, expectAboutTheWindow } from './support/emptySentence';
import {
  AGENT_ROW_LABEL,
  DEFAULT_AGENT_ROWS,
  toDurationDistribution,
  toDurationOverTime,
  toDurationPercentiles,
} from '../src/charts/transforms/agentDurations';
import type { ChartData } from '../src/charts/types';
import fixture from './fixtures/agent-run.json';

/**
 * The Report's duration charts — TCP connect, TLS handshake, DNS resolution —
 * read against `fixtures/agent-run.json`, parsed with the contract schemas so a
 * drifted fixture fails here rather than feeding these cases a shape the page
 * never gets.
 *
 * The fixture's run failed nothing, so every KO population is null or empty:
 * that is what the KO cases lean on. It also has no null OK bucket, so the gap
 * case is synthetic.
 */

const connections = AgentConnectionsResponseSchema.parse(fixture.connections);
const dns = AgentDnsResponseSchema.parse(fixture.dns);
const tcp = connections.tcpConnect;
const tls = connections.tlsHandshake;
const resolution = dns.resolution;

const RUN = { windowSelected: false, noun: 'TCP connects' } as const;
const WINDOW = { windowSelected: true, noun: 'TCP connects' } as const;
/** The payload's own width, which the over-time chart fills a sparse payload's gaps by. */
const WIDTH = connections.bucketWidthMs;
const HIDDEN = ['p25', 'p80', 'p85', 'p99_9', 'p99_99'] as const;

/** One drawn series' pairs, by name. */
function pairs(chart: ChartData, name: string): readonly (readonly [number, number | null])[] {
  const series = chart.series.find((s) => s.name === name);
  if (series === undefined) throw new Error(`no series ${name}`);
  return series.data as readonly (readonly [number, number | null])[];
}

/** One drawn series' plain values (a category-axis chart), by name. */
function values(chart: ChartData, name: string): readonly (number | null)[] {
  const series = chart.series.find((s) => s.name === name);
  if (series === undefined) throw new Error(`no series ${name}`);
  return series.data as readonly (number | null)[];
}

/** A section with nothing in it: no buckets, no bins, no curve, no counts. */
const EMPTY: DurationSection = {
  overTime: [],
  distribution: { offsetMs: 0, stepMs: 1, ok: [], ko: [], meanMs: null },
  percentiles: { ok: [], ko: [], all: [], meanMs: { ok: null, ko: null, all: null } },
  totals: { ok: 0, ko: 0 },
};

describe('the percentile rows', () => {
  it('labels every row as GE does, in GE order', () => {
    expect(AGENT_PERCENTILE_ROWS.map((r) => AGENT_ROW_LABEL[r])).toEqual([
      'Min', '25%', '50%', '75%', '80%', '85%', '90%', '95%', '99%', '99.9%', '99.99%', 'Max', 'Mean',
    ]);
  });

  it('hides 25%, 80%, 85%, 99.9% and 99.99% by default and keeps the order', () => {
    expect(DEFAULT_AGENT_ROWS).toHaveLength(8);
    for (const row of HIDDEN) expect(DEFAULT_AGENT_ROWS).not.toContain(row);
    expect(DEFAULT_AGENT_ROWS).toEqual(AGENT_PERCENTILE_ROWS.filter((r) => !HIDDEN.includes(r as never)));
  });
});

describe('toDurationOverTime', () => {
  const all = toDurationOverTime(tcp, { ...RUN, widthMs: WIDTH, outcome: 'ok', rows: AGENT_PERCENTILE_ROWS });

  it("reads each row from its own index of the bucket's population", () => {
    const max = AGENT_PERCENTILE_ROWS.indexOf('max');
    expect(pairs(all, 'Max')[0]![1]).toBe(tcp.overTime[0]!.ok![max]);
    // Every row, not just Max: a shifted index fails here on whichever row moved.
    AGENT_PERCENTILE_ROWS.forEach((row, i) => {
      expect(pairs(all, AGENT_ROW_LABEL[row])).toEqual(
        tcp.overTime.map((b) => [b.startOffsetMs, b.ok![i]!]),
      );
    });
  });

  it('draws a bucket whose population is null as a gap, never a zero', () => {
    const gapped: DurationSection = {
      ...tcp,
      overTime: tcp.overTime.map((b, i) => (i === 1 ? { ...b, ok: null } : b)),
    };
    const chart = toDurationOverTime(gapped, { ...RUN, widthMs: WIDTH, outcome: 'ok', rows: AGENT_PERCENTILE_ROWS });
    for (const s of chart.series) {
      const point = (s.data as readonly (readonly [number, number | null])[])[1]!;
      expect(point).toEqual([gapped.overTime[1]!.startOffsetMs, null]);
    }
    expect(chart.rows[1]!.values.every((v) => v === '—')).toBe(true);
    expect(chart.limitation).toMatch(new RegExp(`1 of the ${gapped.overTime.length} buckets`));
  });

  it('draws only the selected rows, in GE order, while the table keeps all thirteen', () => {
    const reversed = [...DEFAULT_AGENT_ROWS].reverse();
    const chart = toDurationOverTime(tcp, { ...RUN, widthMs: WIDTH, outcome: 'ok', rows: reversed });
    expect(chart.series.map((s) => s.name)).toEqual(DEFAULT_AGENT_ROWS.map((r) => AGENT_ROW_LABEL[r]));
    expect(chart.series.map((s) => s.name)).not.toContain(AGENT_ROW_LABEL.p99_9);
    expect(chart.columns).toContain(AGENT_ROW_LABEL.p99_9);
    expect(chart.columns).toHaveLength(1 + AGENT_PERCENTILE_ROWS.length);
    for (const row of chart.rows) expect(row.values).toHaveLength(AGENT_PERCENTILE_ROWS.length);
  });

  it('says so when no row is selected, keeping the table', () => {
    const chart = toDurationOverTime(tcp, { ...RUN, widthMs: WIDTH, outcome: 'ok', rows: [] });
    expect(chart.series).toEqual([]);
    expect(chart.empty).toMatch(/no percentile rows are selected/i);
    expect(chart.rows).toHaveLength(tcp.overTime.length);
  });

  it('reads the KO population when asked, and says the run had none rather than drawing nothing', () => {
    expect(tcp.overTime.every((b) => b.ko === null)).toBe(true);
    const run = toDurationOverTime(tcp, { ...RUN, widthMs: WIDTH, outcome: 'ko', rows: AGENT_PERCENTILE_ROWS });
    expectAboutTheRun(run.empty, /failed TCP connects/);
    const win = toDurationOverTime(tcp, { ...WINDOW, widthMs: WIDTH, outcome: 'ko', rows: AGENT_PERCENTILE_ROWS });
    expectAboutTheWindow(win.empty, /failed TCP connects/);
  });

  it('gives the window and run sentences for an empty section', () => {
    expectAboutTheRun(toDurationOverTime(EMPTY, { ...RUN, widthMs: WIDTH, outcome: 'ok', rows: DEFAULT_AGENT_ROWS }).empty, /TCP connects/);
    expectAboutTheWindow(
      toDurationOverTime(EMPTY, { ...WINDOW, widthMs: WIDTH, outcome: 'ok', rows: DEFAULT_AGENT_ROWS }).empty,
      /TCP connects/,
    );
  });
});

describe('toDurationDistribution', () => {
  it('labels each bin at offsetMs + i * stepMs', () => {
    const chart = toDurationDistribution(tls, RUN);
    expect(tls.distribution.offsetMs).not.toBe(0);
    expect(chart.axisLabels).toEqual(
      tls.distribution.ok.map((_, i) => tls.distribution.offsetMs + i * tls.distribution.stepMs),
    );
  });

  it('counts OK to the section total, and keeps KO when it is all zero', () => {
    for (const section of [tcp, tls, resolution]) {
      const chart = toDurationDistribution(section, RUN);
      const ok = values(chart, 'OK').reduce<number>((sum, n) => sum + (n ?? 0), 0);
      expect(ok).toBe(section.totals.ok);
      expect(section.totals.ko).toBe(0);
      expect(values(chart, 'KO')).toEqual(section.distribution.ko);
    }
  });

  it('names the label column for the grid it is: exact values at a 1 ms step, midpoints otherwise', () => {
    expect(tls.distribution.stepMs).toBe(1);
    expect(toDurationDistribution(tls, RUN).columns[0]).toBe('Duration (ms, exact value)');
    const wide = toDurationDistribution({ ...tls, distribution: { ...tls.distribution, stepMs: 5 } }, RUN);
    expect(wide.columns[0]).toBe('Duration (ms, bin midpoint)');
  });

  it('names the count columns after what was counted, keeping the series OK and KO', () => {
    const chart = toDurationDistribution(tls, { windowSelected: false, noun: 'TLS handshakes' });
    expect(chart.columns.slice(1)).toEqual(['OK TLS handshakes', 'KO TLS handshakes']);
    expect(chart.series.map((s) => s.name)).toEqual(['OK', 'KO']);
  });

  it('draws a bin one array lacks as a gap and a dash, never an invented zero', () => {
    const d = tls.distribution;
    const short: DurationSection = { ...tls, distribution: { ...d, ko: d.ko.slice(0, -1) } };
    const chart = toDurationDistribution(short, RUN);
    const last = d.ok.length - 1;
    expect(chart.axisLabels).toHaveLength(d.ok.length);
    expect(values(chart, 'KO')[last]).toBeNull();
    expect(values(chart, 'OK')[last]).toBe(d.ok[last]);
    expect(chart.rows[last]!.values).toEqual([d.ok[last], '—']);
  });

  it('carries the merged mean, saying it is OK and KO together, and no note when there is none', () => {
    const chart = toDurationDistribution(tls, RUN);
    expect(chart.limitation).toBe(
      `Mean of all TCP connects, OK and KO together: ${roundForReading(tls.distribution.meanMs!)} ms`,
    );
    const noMean = toDurationDistribution(
      { ...tls, distribution: { ...tls.distribution, meanMs: null } },
      RUN,
    );
    expect(noMean.limitation).toBeUndefined();
  });

  it('gives the window and run sentences for an empty section', () => {
    expectAboutTheRun(toDurationDistribution(EMPTY, RUN).empty, /TCP connects/);
    expectAboutTheWindow(toDurationDistribution(EMPTY, WINDOW).empty, /TCP connects/);
  });
});

describe('toDurationPercentiles', () => {
  it('draws the whole curve from Min at 0 to Max at 100', () => {
    for (const section of [tcp, tls, resolution]) {
      const chart = toDurationPercentiles(section, 'ok', RUN);
      expect(chart.series.map((s) => s.name)).toEqual(['OK']);
      const curve = pairs(chart, 'OK');
      expect(curve).toEqual(section.percentiles.ok);
      // Cross-checked against the buckets, not against the curve itself.
      const min = Math.min(...section.overTime.map((b) => b.ok![AGENT_PERCENTILE_ROWS.indexOf('min')]!));
      const max = Math.max(...section.overTime.map((b) => b.ok![AGENT_PERCENTILE_ROWS.indexOf('max')]!));
      expect(curve[0]).toEqual([0, min]);
      expect(curve[curve.length - 1]).toEqual([100, max]);
    }
  });

  it("carries the chosen outcome's own mean, naming the outcome", () => {
    const ok = toDurationPercentiles(tls, 'ok', RUN);
    expect(ok.limitation).toBe(
      `Mean of successful TCP connects: ${roundForReading(tls.percentiles.meanMs.ok!)} ms`,
    );
    const all = toDurationPercentiles(tls, 'all', RUN);
    expect(all.limitation).toBe(`Mean of all TCP connects: ${roundForReading(tls.percentiles.meanMs.all!)} ms`);
  });

  it('says the run had no failures rather than drawing an empty KO curve', () => {
    expect(tcp.percentiles.ko).toEqual([]);
    expectAboutTheRun(toDurationPercentiles(tcp, 'ko', RUN).empty, /failed TCP connects/);
    expectAboutTheWindow(toDurationPercentiles(tcp, 'ko', WINDOW).empty, /failed TCP connects/);
  });

  it('gives the window and run sentences for an empty section', () => {
    expectAboutTheRun(toDurationPercentiles(EMPTY, 'ok', RUN).empty, /TCP connects/);
    expectAboutTheWindow(toDurationPercentiles(EMPTY, 'ok', WINDOW).empty, /TCP connects/);
  });
});
