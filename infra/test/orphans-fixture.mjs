#!/usr/bin/env node
// Seed and assert for infra/clean-orphaned-objects.mjs, used by ci.yml's
// `test-residue` job.
//
//   node infra/test/orphans-fixture.mjs seed
//   node infra/clean-orphaned-objects.mjs --delete --min-age-hours 0
//   node infra/test/orphans-fixture.mjs assert
//
// `--min-age-hours 0` is required in CI because every object the fixture
// writes is seconds old and the default 24h guard would exempt all of them --
// the run would pass while deleting nothing. The guard itself is covered by
// its own step, which seeds the same orphans and runs at the DEFAULT age,
// asserting they SURVIVE (`assert-guard`).
//
// FOUR OBJECTS, CHOSEN TO SEPARATE THE TWO KEYING RULES:
//
//   runs/<projectId>/<uuid>.tgz   referenced by run.bundle_key   -> KEEP
//   live/<realRunId>/...bin       run exists                     -> KEEP
//   live/<deadRunId>/...bin       no such run                    -> DELETE
//   runs/<projectId>/stray.tgz    no bundle_key references it    -> DELETE
//
// The last two are what make this fixture worth having. A script that keyed
// `runs/` off the second path segment -- the obvious reading, and WRONG,
// since that segment is the PROJECT id -- would keep the stray, because its
// project does exist. And one that keyed `live/` off bundle_key would delete
// the real run's chunks. Only a fixture holding both shapes at once can tell
// those two mistakes apart.

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const requireStorage = createRequire(
  new URL('../../packages/storage/package.json', import.meta.url),
);
const requirePersistence = createRequire(
  new URL('../../packages/persistence/package.json', import.meta.url),
);

const { S3Client, CreateBucketCommand, PutObjectCommand, HeadObjectCommand } =
  requireStorage('@aws-sdk/client-s3');
const { Pool } = requirePersistence('pg');

const BUCKET = process.env.S3_BUCKET ?? 'perfportal';

const ORG = '90000000-0000-4000-8000-000000000001';
const PROJECT = '90000000-0000-4000-8000-000000000002';
const REAL_RUN = '90000000-0000-4000-8000-000000000003';
const DEAD_RUN = '90000000-0000-4000-8000-0000000000de';

const BUNDLE = `runs/${PROJECT}/90000000-0000-4000-8000-00000000000b.tgz`;
const LIVE_KEEP = `live/${REAL_RUN}/0000000000000000.bin`;
const LIVE_DROP = `live/${DEAD_RUN}/0000000000000000.bin`;
const STRAY = `runs/${PROJECT}/stray.tgz`;

const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'perfportal',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'perfportal123',
  },
  forcePathStyle: true,
});

// See infra/clean-test-buckets.mjs.
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

const die = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const exists = async (Key) => {
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
    return true;
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw e;
  }
};

const mode = process.argv[2];

if (mode === 'seed') {
  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch (e) {
    if (
      e.name !== 'BucketAlreadyOwnedByYou' &&
      e.name !== 'BucketAlreadyExists'
    ) {
      throw e;
    }
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      `INSERT INTO org (id, slug, name) VALUES ($1, 'orphan-fixture', 'Orphan Fixture')
       ON CONFLICT (id) DO NOTHING`,
      [ORG],
    );
    await pool.query(
      `INSERT INTO project (id, org_id, slug, name, settings)
       VALUES ($1, $2, 'orphan-fixture', 'Orphan Fixture', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [PROJECT, ORG],
    );
    await pool.query(
      `INSERT INTO run (id, org_id, project_id, status, tool, bundle_key,
                        bundle_sha256, bundle_bytes, started_at, started_on,
                        engine_options)
       VALUES ($1, $2, $3, 'complete', 'gatling', $4, 'sha', 1, now(),
               current_date, '{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET bundle_key = EXCLUDED.bundle_key`,
      [REAL_RUN, ORG, PROJECT, BUNDLE],
    );
  } finally {
    await pool.end();
  }

  for (const Key of [BUNDLE, LIVE_KEEP, LIVE_DROP, STRAY]) {
    await client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key, Body: 'x' }),
    );
  }
  console.log(`seeded 1 run and 4 objects (2 keep, 2 orphan) in ${BUCKET}`);
} else if (mode === 'assert') {
  if (!(await exists(BUNDLE))) {
    die(`${BUNDLE} was deleted -- a bundle named by run.bundle_key must be kept`);
  }
  if (!(await exists(LIVE_KEEP))) {
    die(`${LIVE_KEEP} was deleted -- its run still exists`);
  }
  if (await exists(LIVE_DROP)) {
    die(`${LIVE_DROP} survived -- its run does not exist, so it is orphaned`);
  }
  if (await exists(STRAY)) {
    die(
      `${STRAY} survived -- no run.bundle_key names it. A rule keyed off the ` +
        `second path segment (the PROJECT id) would wrongly keep this.`,
    );
  }
  console.log('clean-orphaned-objects.mjs: orphans removed, live objects kept');
} else if (mode === 'assert-guard') {
  // Same seed, run at the DEFAULT age: everything is seconds old, so the
  // guard must exempt even the genuinely-orphaned objects.
  for (const Key of [BUNDLE, LIVE_KEEP, LIVE_DROP, STRAY]) {
    if (!(await exists(Key))) {
      die(`${Key} was deleted despite being inside the age guard`);
    }
  }
  console.log('age guard: nothing newer than the window was deleted');
} else {
  die(`usage: orphans-fixture.mjs seed|assert|assert-guard (got ${JSON.stringify(mode)})`);
}
