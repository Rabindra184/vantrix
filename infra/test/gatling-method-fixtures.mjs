#!/usr/bin/env node
/**
 * Proves the Gatling-method tool against three real Gatling 3.15.1 reports.
 *
 * ═══ WHAT IT CHECKS ═══
 *
 * `tools/gatling-method` replays a run's response times into t-digest 3.3's
 * `AVLTreeDigest(100)` the way Gatling's report does, once per seed, and
 * prints each percentile's lowest and highest value across the seeds. This
 * script feeds it the decoded `simulation.log` of each fixture and asserts that
 * every percentile cell Gatling printed in its own report lies inside the
 * tool's [low, high] — and EQUALS it wherever every seed agreed.
 *
 * ═══ WHY A RANGE AND NOT ONE VALUE ═══
 *
 * Gatling's report is not deterministic. `AVLTreeDigest.add` breaks a tie
 * between two equidistant centroids with `gen.nextDouble()`, and `gen` is an
 * UNSEEDED `java.util.Random`, so two reports of one log can print different
 * percentiles. Replaying the reference fixture with seeds 0..199, its
 * all-requests p99 took seven values between 2349 and 2412; the report printed
 * 2369. A check demanding one value would be asserting a coin toss.
 *
 * The `=== low` half is what keeps the range honest: where all 200 seeds agree
 * there IS one answer, and anything else is the method being wrong.
 *
 * ═══ THE THREE FIXTURES ═══
 *
 *   reference-report             index.html + req_*.html + group_*.html
 *   basic-simulation-2026-10-15  the same, from a different run
 *   group-assertions             no HTML; Gatling printed its Search p95 as
 *                                1853 in gatling-report-assertions.txt
 *
 * ═══ USAGE ═══
 *
 *   node infra/test/gatling-method-fixtures.mjs \
 *     --jar tools/gatling-method/build/gatling-method.jar \
 *     --tdigest ~/.perfportal/gatling-home/lib/t-digest-3.3.jar \
 *     --fixtures fixtures/gatling-3.15.1.2 [--seeds 200] [--java java]
 *
 * Exits 0 printing the cell count (which must exceed 150), or 1 naming every
 * failing cell.
 *
 * `parseReportPercentiles(html)` is exported for the TypeScript side.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PERCENTILES = ['50', '75', '95', '99'];
const MIN_CELLS = 150;

// ─── The report parser ────────────────────────────────────────────────────

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** A cell's number, or null for Gatling's "-" (no observation). */
function cellValue(text) {
  const t = decodeEntities(text).trim();
  if (t === '-' || t === '') return null;
  const n = Number(t.replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new Error(`not a number in a report cell: "${t}"`);
  return n;
}

/** Omit a population Gatling printed entirely as "-" (it had no records). */
function population(values) {
  return values.every((v) => v === null) ? undefined : values;
}

/**
 * index.html: one row per stats key, Total column only. The row names carry
 * only the leaf; the path is the chain of `data-parent` ids up to ROOT, which
 * is how the report nests requests under their groups.
 */
function parseIndex(html) {
  const rows = new Map();
  const rowRe = /<tr id="([^"]+)"(?:\s+data-parent="([^"]*)")?\s*>([\s\S]*?)<\/tr>/g;
  for (const m of html.matchAll(rowRe)) {
    const [, id, parent, body] = m;
    const nameMatch = body.match(/class="ellipsed-name">([^<]*)</);
    // A row the parser cannot name is a report it no longer understands, not
    // a row to skip: skipping it would drop its cells from the check silently.
    if (!nameMatch) throw new Error(`index row ${id} has no name`);
    const cells = new Map();
    for (const c of body.matchAll(/<td class="value [^"]*\bcol-(\d+)">([^<]*)<\/td>/g)) {
      cells.set(Number(c[1]), c[2]);
    }
    // col-8..col-11 are 50th, 75th, 95th and 99th pct.
    const total = [8, 9, 10, 11].map((col) => {
      if (!cells.has(col)) throw new Error(`index row ${id} has no col-${col}`);
      return cellValue(cells.get(col));
    });
    rows.set(id, { id, parent: parent ?? null, leaf: decodeEntities(nameMatch[1]), total });
  }
  // Only the index carries the run's own percentiles (no detail page repeats
  // them), so an index that yields no ROOT row would leave the run unchecked.
  if (!rows.has('ROOT')) throw new Error('index.html has no ROOT (All Requests) row');
  const out = [];
  for (const row of rows.values()) {
    if (row.id === 'ROOT') {
      out.push({ scope: 'run', name: '', percentiles: { total: row.total } });
      continue;
    }
    const parts = [row.leaf];
    for (let p = row.parent; p && p !== 'ROOT'; p = rows.get(p)?.parent ?? null) {
      const ancestor = rows.get(p);
      if (!ancestor) throw new Error(`index row ${row.id} names a parent ${p} that is not in the table`);
      parts.unshift(ancestor.leaf);
    }
    const scope = row.id.startsWith('group_') ? 'group' : 'request';
    out.push({ scope, name: parts.join('/'), percentiles: { total: row.total } });
  }
  return out;
}

/**
 * req_*.html / group_*.html: one stats key, with Total, OK and KO columns.
 * The title spells the path with " / "; a group page is the one carrying
 * group-duration charts.
 */
function parseDetail(html) {
  const title = html.match(/<title>Gatling Stats - ([^<]*)<\/title>/);
  if (!title) throw new Error('detail page has no "Gatling Stats - …" title');
  const name = decodeEntities(title[1]).split(' / ').join('/');
  const scope = html.includes('groupDurationDistributionContainerId') ? 'group' : 'request';
  const pops = { total: [], ok: [], ko: [] };
  for (const p of PERCENTILES) {
    const re = new RegExp(
      `<td class="title">${p}th percentile</td>\\s*` +
        `<td class="total">([^<]*)</td>\\s*<td class="ok">([^<]*)</td>\\s*<td class="ko">([^<]*)</td>`,
    );
    const m = html.match(re);
    if (!m) throw new Error(`detail page "${name}" has no ${p}th percentile row`);
    pops.total.push(cellValue(m[1]));
    pops.ok.push(cellValue(m[2]));
    pops.ko.push(cellValue(m[3]));
  }
  const percentiles = { total: pops.total };
  const ok = population(pops.ok);
  const ko = population(pops.ko);
  if (ok) percentiles.ok = ok;
  if (ko) percentiles.ko = ko;
  return [{ scope, name, percentiles }];
}

/**
 * Every percentile cell a Gatling 3.15.1 report page prints.
 *
 * Returns `{ scope, name, percentiles: { total: [p50,p75,p95,p99], ok?, ko? } }[]`
 * — `scope` is `run` / `request` / `group`, `name` the stored identity (path
 * segments joined with `/`, unspaced, `''` for the run). A cell Gatling printed
 * as "-" is null; a population printed entirely as "-" is omitted.
 */
export function parseReportPercentiles(html) {
  return html.includes('id="container_statistics_head"') || html.includes('<tr id="ROOT"')
    ? parseIndex(html)
    : parseDetail(html);
}

// ─── The stats keys a log produces ────────────────────────────────────────

/**
 * Gatling's report keys, each in log order: every request feeds the run and
 * its own request, every group its own group with its CUMULATED response time,
 * each in `total` and its status population.
 */
export function statsKeys(events) {
  const keys = new Map(); // `${scope}\0${name}\0${pop}` -> number[]
  const push = (scope, name, pop, v) => {
    const k = `${scope}\u0000${name}\u0000${pop}`;
    let list = keys.get(k);
    if (!list) keys.set(k, (list = []));
    list.push(v);
  };
  for (const e of events) {
    if (e.type === 'request') {
      const v = e.endMs - e.startMs;
      const status = e.ok ? 'ok' : 'ko';
      const name = [...e.groups, e.name].join('/');
      for (const [scope, n] of [['run', ''], ['request', name]]) {
        push(scope, n, 'total', v);
        push(scope, n, status, v);
      }
    } else if (e.type === 'group') {
      const status = e.ok ? 'ok' : 'ko';
      const name = e.groups.join('/');
      push('group', name, 'total', e.cumulatedResponseTimeMs);
      push('group', name, status, e.cumulatedResponseTimeMs);
    }
  }
  return keys;
}

// ─── Running the tool ─────────────────────────────────────────────────────

function runTool({ java, jar, tdigest, seeds }, keys) {
  // Opaque keys, as the worker sends them: the readable key never crosses the
  // process boundary.
  const ids = new Map();
  let input = '';
  let i = 0;
  for (const [k, values] of keys) {
    const id = `k${i++}`;
    ids.set(id, k);
    for (const v of values) input += `${id}\t${v}\n`;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      java,
      [
        '-cp',
        `${jar}${process.platform === 'win32' ? ';' : ':'}${tdigest}`,
        'io.perfportal.gatlingmethod.GatlingMethod',
        '--seeds',
        String(seeds),
        '--percentiles',
        PERCENTILES.join(','),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const hint = /UnsupportedClassVersionError/.test(err)
          ? ' — the tool is compiled for Java 21; point --java at a Java 21 runtime'
          : '';
        return reject(new Error(`the tool exited ${code}${hint}: ${err.trim()}`));
      }
      const result = new Map();
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        const k = ids.get(row.key);
        if (k === undefined) return reject(new Error(`the tool answered for a key it was never sent: ${row.key}`));
        result.set(k, row);
      }
      for (const [id, k] of ids) {
        if (!result.has(k)) return reject(new Error(`the tool printed nothing for ${id}`));
        if (result.get(k).n !== keys.get(k).length) {
          return reject(new Error(`the tool counted ${result.get(k).n} values for ${id}, sent ${keys.get(k).length}`));
        }
      }
      resolve(result);
    });
    child.stdin.end(input);
  });
}

// ─── The check ────────────────────────────────────────────────────────────

function label(scope, name, pop, p) {
  return `${scope}${name ? ` "${name}"` : ''} ${pop} p${p}`;
}

/**
 * Compares every cell of every page against the tool's ranges, and records in
 * `checked` each stats key at least one cell was compared against.
 */
function checkReport(dir, ranges, failures, checked) {
  let cells = 0;
  const pages = readdirSync(dir).filter((f) => f === 'index.html' || /^(req|group)_.*\.html$/.test(f));
  for (const page of pages.sort()) {
    for (const entry of parseReportPercentiles(readFileSync(join(dir, page), 'utf8'))) {
      for (const [pop, values] of Object.entries(entry.percentiles)) {
        const key = `${entry.scope}\u0000${entry.name}\u0000${pop}`;
        const row = ranges.get(key);
        checked.add(key);
        PERCENTILES.forEach((p, i) => {
          const where = `${dir.split('/').pop()}/${page}: ${label(entry.scope, entry.name, pop, p)}`;
          const reported = values[i];
          cells += 1;
          if (!row) return failures.push(`${where}: the log produced no such key`);
          if (reported === null) return failures.push(`${where}: Gatling printed "-" over ${row.n} values`);
          const [low, high] = row.p[p];
          if (reported < low || reported > high) {
            failures.push(`${where}: Gatling printed ${reported}, the method gives [${low}, ${high}]`);
          } else if (low === high && reported !== low) {
            failures.push(`${where}: every seed gives ${low}, Gatling printed ${reported}`);
          }
        });
      }
    }
  }
  return cells;
}

async function decode(logPath) {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const records = join(here, '../../packages/plugin-gatling/dist/src/records.js');
  if (!existsSync(records)) throw new Error(`decoder not built: ${records} (run pnpm build)`);
  const { parseSimulationLog } = await import(pathToFileURL(records).href);
  return [...parseSimulationLog(readFileSync(logPath))];
}

function parseArgs(argv) {
  const args = { seeds: 200, java: 'java' };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--jar') args.jar = value;
    else if (flag === '--tdigest') args.tdigest = value;
    else if (flag === '--fixtures') args.fixtures = value;
    else if (flag === '--seeds') args.seeds = Number(value);
    else if (flag === '--java') args.java = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  for (const f of ['jar', 'tdigest', 'fixtures']) {
    if (!args[f]) throw new Error(`--${f} is required`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.jar)) throw new Error(`jar not found: ${args.jar}`);
  if (!existsSync(args.tdigest)) throw new Error(`t-digest jar not found: ${args.tdigest}`);

  const failures = [];
  let cells = 0;

  for (const fixture of ['reference-report', 'basic-simulation-2026-10-15']) {
    const dir = join(args.fixtures, fixture);
    const keys = statsKeys(await decode(join(dir, 'simulation.log')));
    const ranges = await runTool(args, keys);
    const checked = new Set();
    const n = checkReport(dir, ranges, failures, checked);
    // Every key the log produced must have been compared at least once — a
    // floor on the TOTAL cell count cannot see one page's parser going blind,
    // because the detail pages duplicate most index cells. The run's ok and ko
    // populations are the only keys Gatling's report prints nowhere.
    for (const key of keys.keys()) {
      if (key === 'run\u0000\u0000ok' || key === 'run\u0000\u0000ko') continue;
      if (!checked.has(key)) {
        const [scope, name, pop] = key.split('\u0000');
        failures.push(`${fixture}: ${label(scope, name, pop, '*')}: the log has this key and no report cell was checked against it`);
      }
    }
    console.log(`${fixture}: ${keys.size} keys, ${n} report cells`);
    cells += n;
  }

  // group-assertions has no HTML: Gatling printed the one percentile it was
  // asked for in its assertion line, and that is the cell.
  {
    const dir = join(args.fixtures, 'group-assertions');
    const printed = readFileSync(join(dir, 'gatling-report-assertions.txt'), 'utf8');
    const m = printed.match(/^Search: 95th percentile of response time .*\(actual : (\d+)\.0\)$/m);
    if (!m) throw new Error('group-assertions: no "Search: 95th percentile … actual" line');
    const reported = Number(m[1]);
    if (reported !== 1853) throw new Error(`group-assertions: expected Gatling's 1853, read ${reported}`);
    const keys = statsKeys(await decode(join(dir, 'simulation.log')));
    const ranges = await runTool(args, keys);
    const row = ranges.get('request\u0000Search\u0000total');
    cells += 1;
    if (!row) failures.push('group-assertions: the log produced no request "Search"');
    else {
      const [low, high] = row.p['95'];
      if (reported < low || reported > high) {
        failures.push(`group-assertions: request "Search" total p95: Gatling printed ${reported}, the method gives [${low}, ${high}]`);
      } else if (low === high && reported !== low) {
        failures.push(`group-assertions: request "Search" total p95: every seed gives ${low}, Gatling printed ${reported}`);
      }
    }
    console.log(`group-assertions: ${keys.size} keys, 1 assertion cell`);
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL ${f}`);
    console.error(`${failures.length} of ${cells} cells failed`);
    process.exit(1);
  }
  if (cells <= MIN_CELLS) {
    console.error(`only ${cells} cells were checked; expected more than ${MIN_CELLS} — the parser has stopped reading the reports`);
    process.exit(1);
  }
  console.log(`${cells} cells checked across 3 Gatling reports, 0 failing`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
