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
// SIX OBJECTS, CHOSEN TO SEPARATE THE THREE KEYING RULES:
//
//   runs/<projectId>/<uuid>.tgz     referenced by run.bundle_key     -> KEEP
//   live/<realRunId>/...bin         run exists                       -> KEEP
//   live/<deadRunId>/...bin         no such run                      -> DELETE
//   runs/<projectId>/stray.tgz      no bundle_key references it      -> DELETE
//   runs/<realRunId>/agent.ndjson   referenced by run.agent_log_key  -> KEEP
//   runs/<deadRunId>/agent.ndjson   no agent_log_key references it   -> DELETE
//
// The agent pair is the on-prem runner's agent file. It sits under `runs/`
// like a bundle, and no bundle_key names it, so a keep-list of bundle keys
// alone deletes every live run's agent file the first time this runs.
//
// The last two are what make this fixture worth having. A script that keyed
// `runs/` off the second path segment -- the obvious reading, and WRONG,
// since that segment is the PROJECT id -- would keep the stray, because its
// project does exist. And one that keyed `live/` off bundle_key would delete
// the real run's chunks. Only a fixture holding both shapes at once can tell
// those two mistakes apart.
//
// `assert-forced` is the same six objects after `TRUNCATE org CASCADE` has
// emptied the run table and --force has lifted the refusal that state
// triggers: with no run to reference anything, all six are orphaned and all
// six must go. It is deliberately the exact opposite assertion to `assert`,
// over the identical seed -- which is what makes the pair able to catch a
// --force that widened what counts as an orphan rather than lifting one
// check. See the three `--force` steps in ci.yml's `test-residue` job.

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
const AGENT_KEEP = `runs/${REAL_RUN}/agent.ndjson`;
const AGENT_DROP = `runs/${DEAD_RUN}/agent.ndjson`;
const ALL = [BUNDLE, LIVE_KEEP, LIVE_DROP, STRAY, AGENT_KEEP, AGENT_DROP];

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
                        engine_options, agent_log_key, agent_log_sha256,
                        agent_log_bytes)
       VALUES ($1, $2, $3, 'complete', 'gatling', $4, 'sha', 1, now(),
               current_date, '{}'::jsonb, $5, 'sha', 1)
       ON CONFLICT (id) DO UPDATE SET bundle_key = EXCLUDED.bundle_key,
                                      agent_log_key = EXCLUDED.agent_log_key`,
      [REAL_RUN, ORG, PROJECT, BUNDLE, AGENT_KEEP],
    );
  } finally {
    await pool.end();
  }

  for (const Key of ALL) {
    await client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key, Body: 'x' }),
    );
  }
  console.log(`seeded 1 run and 6 objects (3 keep, 3 orphan) in ${BUCKET}`);
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
  if (!(await exists(AGENT_KEEP))) {
    die(
      `${AGENT_KEEP} was deleted -- run.agent_log_key names it, so it is the ` +
        `live run's agent file and must be kept`,
    );
  }
  if (await exists(AGENT_DROP)) {
    die(`${AGENT_DROP} survived -- no run.agent_log_key names it, so it is orphaned`);
  }
  console.log('clean-orphaned-objects.mjs: orphans removed, live objects kept');
} else if (mode === 'assert-guard') {
  // Same seed, run at the DEFAULT age: everything is seconds old, so the
  // guard must exempt even the genuinely-orphaned objects.
  for (const Key of ALL) {
    if (!(await exists(Key))) {
      die(`${Key} was deleted despite being inside the age guard`);
    }
  }
  console.log('age guard: nothing newer than the window was deleted');
} else if (mode === 'assert-forced') {
  // The run table was emptied, so nothing references anything: every object
  // here is genuinely orphaned and --force must have removed all six. The
  // bundle is the one that matters -- it is the object the ordinary `assert`
  // requires be KEPT, so a --force that quietly did nothing leaves it behind
  // and fails here, and a refusal that was never lifted fails here too.
  for (const Key of ALL) {
    if (await exists(Key)) {
      die(
        `${Key} survived --force against an empty run table -- with no run ` +
          `rows left, nothing references it and it is orphaned`,
      );
    }
  }
  console.log('--force: every object of an emptied database was swept');
} else {
  die(
    `usage: orphans-fixture.mjs seed|assert|assert-guard|assert-forced ` +
      `(got ${JSON.stringify(mode)})`,
  );
}
