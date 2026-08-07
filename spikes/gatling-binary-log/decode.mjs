/**
 * SPIKE — Gatling 3.15.1.2 binary simulation.log decoder.
 *
 * Format recovered from the shipped jars:
 *   io.gatling.core.stats.writer.{RecordHeader,*MessageSerializer,BufferedFileChannelWriter}
 *   io.gatling.charts.stats.LogFileParser
 *
 * Purpose: prove the binary format is decodable into canonical events, and
 * validate by reproducing the report's own published statistics exactly.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RECORD = { RUN: 0, REQUEST: 1, USER: 2, GROUP: 3, ERROR: 4 };

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
    this.stringCache = new Map();   // index -> string
  }
  get eof()      { return this.pos >= this.buf.length; }
  readByte()     { return this.buf.readInt8(this.pos++); }
  readBoolean()  { return this.buf.readInt8(this.pos++) !== 0; }
  readInt()      { const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  readLong()     { const v = this.buf.readBigInt64BE(this.pos); this.pos += 8; return Number(v); }

  /** string = int32 len; if len === 0 -> ""; else len bytes + 1 coder byte (0=LATIN1, 1=UTF16) */
  readString() {
    const len = this.readInt();
    if (len === 0) return '';
    const bytes = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    const coder = this.readByte();
    return coder === 0 ? bytes.toString('latin1') : bytes.toString('utf16le');
  }

  /**
   * cachedString: int32 i.
   *   i >= 0  -> a NEW string follows inline; cache it under i
   *   i <  0  -> back-reference to cache[-i]
   * The sign is the discriminator (per LogFileParser.readCachedSanitizedString).
   * Note index 0 can never be back-referenced, since -0 === 0.
   */
  readCachedString() {
    const i = this.readInt();
    if (i >= 0) {
      const s = this.readString();
      this.stringCache.set(i, s);
      return s;
    }
    const s = this.stringCache.get(-i);
    if (s === undefined) throw new Error(`dangling string back-reference ${-i} at byte ${this.pos - 4}`);
    return s;
  }

  readByteArray() {
    const len = this.readInt();
    const b = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return b;
  }
  readGroups() {
    const n = this.readInt();
    const g = [];
    for (let i = 0; i < n; i++) g.push(this.readCachedString());
    return g;
  }
}

export function decode(path) {
  const r = new Reader(readFileSync(path));

  // ---- header (RecordHeader.Run) ----
  const header = r.readByte();
  if (header !== RECORD.RUN) throw new Error(`expected Run record, got ${header}`);
  const run = {
    gatlingVersion: r.readString(),
    simulationClassName: r.readString(),
    runStart: r.readLong(),
    runDescription: r.readString(),
    scenarios: [],
    assertionCount: 0,
  };
  const scenarioCount = r.readInt();
  for (let i = 0; i < scenarioCount; i++) run.scenarios.push(r.readString());
  run.assertionCount = r.readInt();
  for (let i = 0; i < run.assertionCount; i++) r.readByteArray();   // protobuf; not decoded here

  // ---- records ----
  const requests = [], users = [], groups = [], errors = [];
  while (!r.eof) {
    const type = r.readByte();
    switch (type) {
      case RECORD.REQUEST: {
        const groupHierarchy = r.readGroups();
        const name  = r.readCachedString();
        const start = r.readInt();
        const end   = r.readInt();
        const ok    = r.readBoolean();
        const message = r.readCachedString();
        requests.push({ groupHierarchy, name, start, end, ok, message, duration: end - start });
        break;
      }
      case RECORD.USER: {
        users.push({
          scenario: run.scenarios[r.readInt()],
          start: r.readBoolean(),
          ts: r.readInt(),
        });
        break;
      }
      case RECORD.GROUP: {
        const groupHierarchy = r.readGroups();
        groups.push({
          groupHierarchy,
          start: r.readInt(),
          end: r.readInt(),
          cumulatedResponseTime: r.readInt(),
          ok: r.readBoolean(),
        });
        break;
      }
      case RECORD.ERROR: {
        errors.push({ message: r.readCachedString(), ts: r.readInt() });
        break;
      }
      default:
        throw new Error(`unknown record type ${type} at byte ${r.pos - 1}`);
    }
  }
  return { run, requests, users, groups, errors, bytesConsumed: r.pos, totalBytes: r.buf.length };
}

// ---------------- validation against the report's published numbers ----------------
// Guarded so this file stays importable: `import { decode } from './decode.mjs'`
// must not run the CLI or call process.exit.

const pct = (sorted, p) => {           // nearest-rank, matching Gatling's reported integers
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
};

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isCli) { /* imported as a library — skip the report below */ }
else {

const path = process.argv[2];
const d = decode(path);
const all = d.requests.map(r => r.duration).sort((a, b) => a - b);
const ok = d.requests.filter(r => r.ok);
const ko = d.requests.filter(r => !r.ok);
const mean = all.reduce((a, b) => a + b, 0) / all.length;
const stddev = Math.sqrt(all.reduce((s, v) => s + (v - mean) ** 2, 0) / all.length);

const errCounts = new Map();
for (const r of ko) errCounts.set(r.message, (errCounts.get(r.message) ?? 0) + 1);

// indicator bands (Gatling defaults 800 / 1200)
const under800 = ok.filter(r => r.duration < 800).length;
const between  = ok.filter(r => r.duration >= 800 && r.duration < 1200).length;
const over1200 = ok.filter(r => r.duration >= 1200).length;

// EXACT: must equal Gatling's displayed value.
// ESTIMATE: Gatling reports a histogram estimate, so a difference is EXPECTED and
//   correct — we compute the true value from the full sorted set (PRD §A.9 F-6).
const EXACT = {
  'total requests': [d.requests.length, 895],
  'KO count':       [ko.length, 24],
  'OK t < 800ms':   [under800, 848],
  'OK 800-1200ms':  [between, 0],
  'OK t >= 1200ms': [over1200, 23],
  'max':            [all[all.length - 1], 2503],
  'mean':           [Math.round(mean), 228],
  'stddev':         [Math.round(stddev), 370],
  'scenario count': [d.run.scenarios.length, 2],
  'assertion count':[d.run.assertionCount, 3],
};
const ESTIMATE = {
  'p50': [pct(all, 50), 109],
  'p75': [pct(all, 75), 250],
  'p95': [pct(all, 95), 654],
  'p99': [pct(all, 99), 2369],
};

console.log(`\ngatling version      : ${d.run.gatlingVersion}`);
console.log(`simulation           : ${d.run.simulationClassName}`);
console.log(`run start            : ${new Date(d.run.runStart).toISOString()}`);
console.log(`scenarios            : ${d.run.scenarios.join(', ')}`);
console.log(`bytes consumed       : ${d.bytesConsumed} / ${d.totalBytes} ${d.bytesConsumed === d.totalBytes ? '(clean EOF)' : '*** TRAILING BYTES ***'}`);
console.log(`records              : ${d.requests.length} request, ${d.users.length} user, ${d.groups.length} group, ${d.errors.length} error`);
console.log(`distinct groups      : ${[...new Set(d.groups.map(g => g.groupHierarchy.join(' / ')))].join('  |  ')}`);
console.log(`distinct endpoints   : ${[...new Set(d.requests.map(r => r.name))].join(', ')}`);

console.log('\n--- EXACT quantities: must match Gatling exactly ---');
let fails = 0;
for (const [k, [got, want]] of Object.entries(EXACT)) {
  const pass = got === want;
  if (!pass) fails++;
  console.log(`  ${k.padEnd(17)} ${String(got).padStart(8)}   gatling ${String(want).padStart(8)}   ${pass ? 'MATCH' : '*** MISMATCH ***'}`);
}
console.log(`  ${'min'.padEnd(17)} ${String(all[0]).padStart(8)}   (not published by Gatling)`);

console.log('\n--- ESTIMATED quantities: Gatling reports histogram estimates (PRD A.9 F-6) ---');
for (const [k, [truth, gatling]] of Object.entries(ESTIMATE)) {
  const drift = ((truth - gatling) / gatling) * 100;
  const inData = all.includes(gatling);
  console.log(
    `  ${k.padEnd(17)} true ${String(truth).padStart(6)}   gatling ${String(gatling).padStart(6)}` +
    `   ${drift >= 0 ? '+' : ''}${drift.toFixed(1)}%` +
    `   gatling value ${inData ? 'occurs in data' : 'DOES NOT OCCUR IN DATA'}`
  );
}

console.log('\n--- error messages (expected: 15x found 500, 9x found 503) ---');
for (const [m, c] of [...errCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(4)}  ${m}`);

console.log(
  `\n${fails === 0
    ? 'PASS — every exact statistic reproduced from raw bytes; percentile drift is Gatling estimator error, as expected'
    : `FAIL — ${fails} exact value(s) mismatched`}\n`
);
process.exit(fails === 0 ? 0 : 1);

}
