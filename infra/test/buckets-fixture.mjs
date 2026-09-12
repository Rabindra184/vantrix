#!/usr/bin/env node
// Seed and assert for infra/clean-test-buckets.mjs, used by ci.yml's
// `test-residue` job.
//
//   node infra/test/buckets-fixture.mjs seed
//   node infra/clean-test-buckets.mjs
//   node infra/test/buckets-fixture.mjs assert
//
// BOTH DIRECTIONS ARE ASSERTED, which is what makes a broken-script fixture
// unnecessary here (unlike the SQL half, where residue-broken.sql is needed).
// A script that deletes NOTHING fails on the test bucket still existing; one
// whose pattern grew too broad fails on the real bucket or its object being
// gone. Neither failure can hide behind the other.

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(
  new URL('../../packages/storage/package.json', import.meta.url),
);
const {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  ListBucketsCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');

// A fixed uuid, so `assert` knows the name `seed` chose without passing state
// between two processes. It still has to MATCH the script's `test-<uuid>`
// pattern -- that is the thing under test.
const TEST_BUCKET = 'test-00000000-0000-4000-8000-000000000000';
const REAL_BUCKET = process.env.S3_BUCKET ?? 'perfportal';
const KEY = 'ci-fixture/keep.txt';
const BODY = 'this object must survive';

const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'perfportal',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'perfportal123',
  },
  forcePathStyle: true,
});

// See the long comment in infra/clean-test-buckets.mjs -- same MinIO, same
// legacy Content-MD5 requirement.
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

const names = async () =>
  (await client.send(new ListBucketsCommand({}))).Buckets.map((b) => b.Name);

const ensure = async (Bucket) => {
  try {
    await client.send(new CreateBucketCommand({ Bucket }));
  } catch (e) {
    // Re-running seed against a live stack must not be an error.
    if (
      e.name !== 'BucketAlreadyOwnedByYou' &&
      e.name !== 'BucketAlreadyExists'
    ) {
      throw e;
    }
  }
};

const die = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const mode = process.argv[2];

if (mode === 'seed') {
  await ensure(REAL_BUCKET);
  await ensure(TEST_BUCKET);
  // An object in each: an empty bucket would let a DeleteBucket-only script
  // pass without ever proving it can empty one.
  await client.send(
    new PutObjectCommand({ Bucket: REAL_BUCKET, Key: KEY, Body: BODY }),
  );
  await client.send(
    new PutObjectCommand({ Bucket: TEST_BUCKET, Key: 'junk.txt', Body: 'x' }),
  );
  console.log(`seeded ${REAL_BUCKET} and ${TEST_BUCKET}, one object each`);
} else if (mode === 'assert') {
  const present = await names();

  if (present.includes(TEST_BUCKET)) {
    die(`${TEST_BUCKET} still exists -- the script deleted nothing`);
  }
  if (!present.includes(REAL_BUCKET)) {
    die(`${REAL_BUCKET} was deleted -- the test-<uuid> pattern is too broad`);
  }

  const got = await client.send(
    new GetObjectCommand({ Bucket: REAL_BUCKET, Key: KEY }),
  );
  const body = await got.Body.transformToString();
  if (body !== BODY) {
    die(`${REAL_BUCKET}/${KEY} changed: ${JSON.stringify(body)}`);
  }

  console.log(
    `clean-test-buckets.mjs: ${TEST_BUCKET} removed, ${REAL_BUCKET} and its object intact`,
  );
} else {
  die(`usage: buckets-fixture.mjs seed|assert (got ${JSON.stringify(mode)})`);
}
