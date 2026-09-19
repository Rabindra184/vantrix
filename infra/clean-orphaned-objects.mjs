#!/usr/bin/env node
// Remove objects in the REAL bucket whose run no longer exists.
//
// This is the third residue, and the only one that touches the live bucket:
// infra/clean-test-residue.sql removes test orgs, infra/clean-test-buckets.mjs
// removes whole `test-<uuid>` buckets, and neither looks inside `perfportal`.
// Measured 2026-09-12: 129,465 objects / 48.2 MB against ONE surviving run.
//
// Most of it is expected debris rather than a bug. `LiveChunkStore.finalize`
// writes the assembled log and then deletes the run's chunks, and when that
// delete fails it says so and "leaves debris for a lifecycle rule to reap".
// There is no lifecycle rule on the compose MinIO. This is that reaper.
//
// DRY RUN BY DEFAULT, unlike its two siblings. They delete by a pattern only
// a fixture can produce, so the worst case is doing nothing. This one deletes
// from the bucket that holds real bundles, and its keep-list is derived from
// live database state -- point it at the wrong DATABASE_URL and every rule
// below is computed against the wrong answer. Pass --delete once the dry-run
// summary looks right.
//
// TWO KEY SHAPES, AND THEY ARE NOT KEYED THE SAME WAY. Getting this wrong is
// how a cleanup destroys live bundles:
//
//   live/{runId}/{offset}.bin        packages/storage/src/live-chunks.ts
//   runs/{projectId}/{uuid}.tgz      apps/api/src/ingest/ingest.service.ts
//                    ^^^^^^^^^ PROJECT id, not run id
//
// So the second path segment means different things in the two prefixes, and
// a rule that read "the uuid after the prefix is the run" would delete every
// bundle belonging to a project whose id never appears in `run.id`. Both
// shapes were read out of the source, not inferred from a sample.
//
// The `runs/` rule therefore does not parse the key at all: `run.bundle_key`
// stores the FULL object key, so that column is an exact keep-list. That also
// disposes of `runs/test/...` and `runs/collide/...`, which storage's own
// integration tests write under literal non-uuid prefixes.
//
// THE AGE GUARD IS WHAT MAKES THE RACE SAFE. The database is snapshotted
// before the bucket is listed, so a run opened during the sweep has no row in
// that snapshot and its chunks would look orphaned. Nothing younger than
// --min-age-hours (default 24) is ever deleted, which is far longer than any
// ingest or live stream takes to record its row.
//
// --force DOES NOT LIFT THAT, AND THE SEPARATION IS THE WHOLE POINT. The two
// guards answer different questions: the age guard asks "might this object
// belong to a run that has not recorded its row yet", and the empty-table
// refusal asks "is this keep-list computed from the database I meant". Only
// the second is something an operator can be sure about from outside, so only
// the second has an override. A --force that also skipped the age guard would
// delete an in-flight run's chunks on a live instance, which is exactly the
// failure the age guard exists to prevent -- and nothing about knowing your
// DATABASE_URL makes that safe. ci.yml's `test-residue` job pins this.
//
// Usage, from the repository root:
//
//   node infra/clean-orphaned-objects.mjs                  # dry run
//   node infra/clean-orphaned-objects.mjs --delete
//   node infra/clean-orphaned-objects.mjs --delete --min-age-hours 72
//   node infra/clean-orphaned-objects.mjs --delete --force  # empty run table
//
// Reads DATABASE_URL, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET.

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const requireStorage = createRequire(
  new URL('../packages/storage/package.json', import.meta.url),
);
const requirePersistence = createRequire(
  new URL('../packages/persistence/package.json', import.meta.url),
);

const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = requireStorage('@aws-sdk/client-s3');
const { Pool } = requirePersistence('pg');

const argv = process.argv.slice(2);
const DELETE = argv.includes('--delete');
const FORCE = argv.includes('--force');
const BUCKET = process.env.S3_BUCKET ?? 'perfportal';

const ageIdx = argv.indexOf('--min-age-hours');
const MIN_AGE_HOURS = ageIdx === -1 ? 24 : Number(argv[ageIdx + 1]);
if (!Number.isFinite(MIN_AGE_HOURS) || MIN_AGE_HOURS < 0) {
  console.error(`--min-age-hours must be a non-negative number`);
  process.exit(1);
}
const cutoff = new Date(Date.now() - MIN_AGE_HOURS * 3_600_000);

const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'perfportal',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'perfportal123',
  },
  forcePathStyle: true,
});

// See infra/clean-test-buckets.mjs for why this is necessary.
client.middlewareStack.add(
  (next) => async (args) => {
    const req = args.request;
    if (req?.body && req.headers && req.headers['content-md5'] === undefined) {
      req.headers['content-md5'] = createHash('md5')
        .update(req.body)
        .digest('base64');
    }
    return next(args);
  },
  { step: 'build', name: 'contentMd5ForMinio' },
);

// ── 1. Snapshot the database FIRST. Anything created after this point is
//       protected by the age guard rather than by this set.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let runIds, bundleKeys;
try {
  const rows = await pool.query(
    `SELECT id::text AS id, bundle_key FROM run`,
  );
  runIds = new Set(rows.rows.map((r) => r.id));
  bundleKeys = new Set(
    rows.rows.map((r) => r.bundle_key).filter((k) => k != null),
  );
} finally {
  await pool.end();
}

// WHICH DATABASE ANSWERED, WITHOUT ITS CREDENTIALS. The refusal below exists
// because the likeliest cause of an empty run table is a mis-pointed
// DATABASE_URL, and --force turns that from something the script can catch
// into something the operator has to be right about -- so both messages have
// to name the database rather than say "set". Host and path only: this prints
// into CI logs, and `${u.username}:${u.password}@` must never reach one.
const dbLabel = (() => {
  const raw = process.env.DATABASE_URL;
  if (!raw) return 'DATABASE_URL UNSET';
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname}`;
  } catch {
    return 'DATABASE_URL unparseable';
  }
})();

// A database with no runs at all is far more likely to be the wrong
// DATABASE_URL, or one a test run has just truncated, than a real instance
// that has never ingested anything -- and in that state every rule below says
// "delete everything". Refuse rather than compute the right answer to the
// wrong question.
//
// --force is for the case that refusal cannot distinguish: a dev database
// somebody has just emptied on purpose, whose bucket is then entirely
// orphaned and which this script would otherwise decline to clean for ever.
// It lifts THIS check and nothing else -- see the age-guard note at the top.
if (runIds.size === 0 && DELETE && !FORCE) {
  console.error(
    `refusing to delete: the run table is empty, so every object in ` +
      `${BUCKET} would be classified as orphaned. Check DATABASE_URL ` +
      `(currently ${dbLabel}). Re-run without --delete to see the ` +
      `classification, or pass --force if that database is empty on purpose.`,
  );
  process.exit(1);
}

if (DELETE && FORCE) {
  // Loud, and specific about what it is overriding: a --force that printed
  // nothing would make the two runs indistinguishable in a CI log or a
  // scrollback, which is precisely when somebody needs to see it.
  console.warn(
    runIds.size === 0
      ? `--force: the run table at ${dbLabel} is empty, so EVERY object in ` +
          `${BUCKET} outside the age guard is treated as orphaned.`
      : `--force: no effect here — ${dbLabel} reports ${runIds.size} run(s), ` +
          `so the keep-list is the ordinary one.`,
  );
}

console.log(
  `${runIds.size} run(s) known, ${bundleKeys.size} bundle key(s); ` +
    `objects newer than ${cutoff.toISOString()} are exempt` +
    (DELETE ? '' : '  [DRY RUN — pass --delete to apply]'),
);

// ── 2. Classify every object.
const orphans = [];
let kept = 0;
let tooNew = 0;
let scanned = 0;
let orphanBytes = 0;
const keptBy = { bundle: 0, liveRun: 0 };

let ContinuationToken;
do {
  const page = await client.send(
    new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken }),
  );
  for (const o of page.Contents ?? []) {
    scanned++;

    // `runs/…`: exact match against run.bundle_key. No key parsing.
    if (bundleKeys.has(o.Key)) {
      kept++;
      keptBy.bundle++;
      continue;
    }

    // `live/{runId}/…`: the run still exists, so its chunks are in use or
    // are finalize's problem, not ours.
    if (o.Key.startsWith('live/')) {
      const runId = o.Key.slice('live/'.length, o.Key.indexOf('/', 5));
      if (runIds.has(runId)) {
        kept++;
        keptBy.liveRun++;
        continue;
      }
    }

    if (o.LastModified && o.LastModified > cutoff) {
      tooNew++;
      continue;
    }

    orphans.push({ Key: o.Key });
    orphanBytes += o.Size ?? 0;
  }
  ContinuationToken = page.NextContinuationToken;
} while (ContinuationToken);

const prefixOf = (k) => (k.startsWith('live/') ? 'live/' : k.split('/')[0] + '/');
const byPrefix = {};
for (const o of orphans) byPrefix[prefixOf(o.Key)] = (byPrefix[prefixOf(o.Key)] ?? 0) + 1;

console.log(`scanned ${scanned} object(s) in ${BUCKET}`);
console.log(`  kept    ${kept} (${keptBy.bundle} bundle, ${keptBy.liveRun} live chunks of a known run)`);
console.log(`  too new ${tooNew} (inside the ${MIN_AGE_HOURS}h guard)`);
console.log(`  orphan  ${orphans.length} = ${(orphanBytes / 1048576).toFixed(1)} MB`);
for (const [p, n] of Object.entries(byPrefix).sort((a, b) => b[1] - a[1])) {
  console.log(`            ${n}  ${p}`);
}

if (!DELETE || orphans.length === 0) {
  if (!DELETE && orphans.length > 0) console.log('nothing deleted (dry run)');
  process.exit(0);
}

// ── 3. Delete, 1000 keys per request.
let deleted = 0;
for (let i = 0; i < orphans.length; i += 1000) {
  const batch = orphans.slice(i, i + 1000);
  const res = await client.send(
    new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: batch } }),
  );
  if (res.Errors?.length) {
    throw new Error(
      `${res.Errors.length} object(s) would not delete, first: ` +
        `${res.Errors[0].Key} ${res.Errors[0].Code}`,
    );
  }
  deleted += batch.length;
  process.stdout.write(`\r  deleted ${deleted}/${orphans.length}`);
}
console.log(`\ndone: ${deleted} object(s), ${(orphanBytes / 1048576).toFixed(1)} MB`);
