import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IngestMetadataSchema } from '../src/ingest.js';
import { OpenLiveRunRequestSchema } from '../src/live.js';
import { TelemetryBatchSchema } from '../src/metrics.js';

/**
 * THE DEFECT THESE GUARD. Nine bounded string fields on the ingest, live and
 * telemetry request schemas did not trim, while every other request schema in
 * this package did — `project.ts`, `rules.ts`, `runner.ts`, `test.ts`,
 * `tokens.ts`, and `DeclaredTestSlugSchema`, whose docstring says in as many
 * words that it is SHARED "so the four submit paths cannot drift into
 * disagreeing". Three of the four paths trimmed their provenance; two did not.
 *
 * IT WAS LIVE, AND MEASURED AGAINST A REAL API. A run posted with
 * `environment: "staging "` stored `[staging ]`, and `comparabilityBreaks`
 * compares those axes with `a === b` — so the trend line broke between two
 * runs of one environment, carrying a spacer whose label read
 * `staging → staging` and the sentence "environment changed between runs, so
 * the points either side were not measured under the same conditions." A
 * false claim, in the one place a reader cannot see the cause.
 *
 * THE SERVER IS THE ONLY PLACE THIS CAN BE FIXED. There are four submit paths
 * in three languages — this package's two schemas, the Kotlin Gradle plugin,
 * and the Go agent for telemetry — and none of the clients trims: the agent
 * sends `--host-label` verbatim (no `TrimSpace` anywhere in `agent/`) and the
 * plugin forwards `env["VANTRIX_ENVIRONMENT"]` as it finds it. A fix in one
 * client leaves the other three.
 */

const PAD = (s: string): string => `  ${s}\t`;

/**
 * One valid sample. `samples` has `.min(1)`, so a batch with an empty array is
 * refused whatever its `host` says — which made the first draft of the
 * whitespace case below pass for a reason that had nothing to do with the
 * field it names. A malformed fixture is silent in one direction and
 * misdirecting in the other.
 */
const SAMPLE = {
  sampledAt: '2026-09-25T08:00:00.000Z',
  cpuUserMs: 0, cpuSystemMs: 0, cpuIdleMs: 0, cpuIowaitMs: 0,
  memUsedBytes: 0, memTotalBytes: 0, netRxBytes: 0, netTxBytes: 0,
  tcpInSegs: 0, tcpOutSegs: 0, tcpRetransSegs: 0, tcpInErrs: 0,
  tcpActiveOpens: 0, tcpPassiveOpens: 0, tcpStates: {},
};

describe('every typed input is trimmed before it is stored', () => {
  it('trims the provenance a bundle upload declares', () => {
    const parsed = IngestMetadataSchema.parse({
      tool: 'gatling',
      environment: PAD('staging'),
      branch: PAD('main'),
      commitSha: PAD('abc1234'),
      idempotencyKey: PAD('build-42'),
    });
    expect(parsed).toMatchObject({
      environment: 'staging',
      branch: 'main',
      commitSha: 'abc1234',
      idempotencyKey: 'build-42',
    });
  });

  it('trims the same provenance when a live run declares it', () => {
    const parsed = OpenLiveRunRequestSchema.parse({
      tool: 'gatling',
      environment: PAD('staging'),
      branch: PAD('main'),
      commitSha: PAD('abc1234'),
      idempotencyKey: PAD('build-42'),
    });
    expect(parsed).toMatchObject({
      environment: 'staging',
      branch: 'main',
      commitSha: 'abc1234',
      idempotencyKey: 'build-42',
    });
  });

  /**
   * `host` is a REQUEST field despite living beside the metrics responses, and
   * its own docstring calls it "the dimension every telemetry chart groups
   * by". An untrimmed label is a second generator in every chart.
   */
  it('trims the generator label the telemetry agent reports', () => {
    const parsed = TelemetryBatchSchema.parse({
      host: PAD('gen-01'),
      samples: [SAMPLE],
    });
    expect(parsed.host).toBe('gen-01');
  });

  /**
   * THE PAIR THAT STOPS "TRIMMED" BECOMING "SILENTLY EMPTIED". `.min(1)` runs
   * after the trim, so whitespace alone is REFUSED rather than stored as `''`
   * — which matters because `comparability` already treats `''` as unknown,
   * so an emptied environment would go from a false break to a silently
   * missing fact.
   */
  it('refuses a value that is only whitespace, rather than storing an empty one', () => {
    expect(IngestMetadataSchema.safeParse({ tool: 'gatling', environment: '   ' }).success).toBe(false);
    expect(TelemetryBatchSchema.safeParse({ host: '   ', samples: [SAMPLE] }).success).toBe(false);
  });

  /** And the other half: an ordinary value is untouched. */
  it('leaves a value that needs no trimming exactly as it was', () => {
    const parsed = IngestMetadataSchema.parse({ tool: 'gatling', environment: 'staging', branch: 'main' });
    expect(parsed).toMatchObject({ environment: 'staging', branch: 'main' });
  });

  /**
   * THE DERIVED GUARD, so a field added later joins by EXISTING rather than by
   * somebody remembering. A length bound is the signal that a human types the
   * value: `z.string().uuid()`, `.datetime()` and the bare record keys carry
   * none and are machine-produced, so they are not swept.
   *
   * COMMENTS ARE STRIPPED FIRST and that is load-bearing — this file and the
   * corrected schemas both quote `z.string().min(1)` while explaining the
   * rule, so without the strip the guard fails on its own prose.
   */
  it('lets no bounded input string in this package skip the trim', () => {
    const dir = `${process.cwd()}/packages/contracts/src`;
    const strip = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length, 'collected no contract sources — the path has rotted').toBeGreaterThan(5);

    let bounded = 0;
    const offenders: string[] = [];
    for (const file of files) {
      for (const line of strip(readFileSync(`${dir}/${file}`, 'utf8')).split('\n')) {
        if (!/z\.string\(\)[.a-zA-Z()0-9_]*\.(min|max)\(/.test(line)) continue;
        bounded += 1;
        // `problem.ts` is the one exemption and is argued: every field there
        // is written by THIS server for an error document, never received, so
        // there is no client whitespace to absorb. Delete the exemption the
        // day a Problem field becomes an input.
        if (file === 'problem.ts') continue;
        if (!/z\.string\(\)\.trim\(\)/.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    // Vacuity: a regex that stopped matching would report zero offenders for
    // ever, which is indistinguishable from a clean package.
    expect(bounded, 'matched no bounded strings — the pattern has rotted').toBeGreaterThan(20);
    expect(offenders, offenders.join('; ')).toEqual([]);
  });
});
