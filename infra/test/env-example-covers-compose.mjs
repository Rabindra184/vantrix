#!/usr/bin/env node
/**
 * Every `${PERFPORTAL_*}` the compose file reads must have a line in
 * `infra/.env.example`.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * `.env.example` is the whole configuration surface a deployer sees. It is
 * also exactly the kind of file that rots: a variable gets added to
 * `docker-compose.yml`, the example is not updated, and the next deployer is
 * back to deriving settings from prose — which is the defect the example was
 * added to fix, returning silently.
 *
 * Nothing else can catch it. `docker compose config` interpolates a MISSING
 * variable to empty (or fails on `:?`, which only covers three of them), so a
 * complete-looking parse says nothing about whether the example documents it.
 *
 * CLAUDE.md's rule for this directory is the reason it is wired into the
 * `compose` CI job rather than left as a convention: `infra/` is in no `pnpm`
 * gate, so a file nobody runs is a file that breaks on somebody else's
 * schedule.
 *
 * Usage:  node infra/test/env-example-covers-compose.mjs [composeFile] [exampleFile]
 */
import { readFileSync } from 'node:fs';

const composePath = process.argv[2] ?? 'infra/docker-compose.yml';
const examplePath = process.argv[3] ?? 'infra/.env.example';

const compose = readFileSync(composePath, 'utf8');
const example = readFileSync(examplePath, 'utf8');

/* `[A-Z0-9_]` and not `[A-Z_]`: the S3 keys carry a digit, and a character
   class that omits it truncates `PERFPORTAL_S3_ACCESS_KEY` to `PERFPORTAL_S`
   — which then "matches" nothing and reports a variable that does not exist.
   That happened while writing this. */
const referenced = [...compose.matchAll(/\$\{(PERFPORTAL_[A-Z0-9_]+)/g)].map((m) => m[1]);
const wanted = [...new Set(referenced)].sort();

/* Only a real assignment counts. A variable merely NAMED in a comment is the
   stale-cross-reference shape this repo has paid for three times: it reads as
   documentation and configures nothing. */
const documented = new Set(
  example
    .split('\n')
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=/))
    .filter(Boolean)
    .map((m) => m[1]),
);

const missing = wanted.filter((v) => !documented.has(v));
const extra = [...documented].filter((v) => v.startsWith('PERFPORTAL_') && !wanted.includes(v));

for (const v of wanted) console.log(`  ${documented.has(v) ? 'ok  ' : 'MISS'} ${v}`);
for (const v of extra) console.log(`  DEAD ${v} — in the example, read by nothing`);

if (missing.length > 0 || extra.length > 0) {
  console.error(
    `\n${examplePath} is out of step with ${composePath}:` +
      (missing.length ? `\n  undocumented: ${missing.join(', ')}` : '') +
      (extra.length ? `\n  documents nothing: ${extra.join(', ')}` : ''),
  );
  process.exit(1);
}
console.log(`\n${wanted.length} variables, all documented.`);
