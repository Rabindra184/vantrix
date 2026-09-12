#!/usr/bin/env node
// Remove the S3 buckets packages/storage's integration tests leave behind.
//
// WHY THIS IS NOT SQL, AND NOT `rm -rf`. `infra/clean-test-residue.sql`
// handles the database half. This is the other half, and it cannot be done
// the obvious way: MinIO keeps its own metadata under `/data/.minio.sys`, so
// deleting a bucket's directory out from under it corrupts the server rather
// than freeing the space. A bucket has to go through the S3 API, which means
// a signed client.
//
// Measured 2026-09-12 on this machine: 8 stale `test-<uuid>` buckets, against
// one real one. They accumulate exactly the way the orgs did, and nothing
// removes them -- `test:integration` truncates the DATABASE on setup and has
// never touched object storage.
//
// IT DELETES BY PATTERN, same safety property as the SQL. The only shape a
// fixture generates is `test-${randomUUID()}` --
// packages/storage/test/blobs.integration.test.ts and
// live-chunks.integration.test.ts, both grepped rather than remembered. A
// bucket that does not match is left alone, so pointing this at a real
// endpoint is a no-op rather than a catastrophe.
//
// The configured bucket is refused a SECOND time, independently of the
// regex (see REAL_BUCKET below). One guard is a pattern nobody re-reads; two
// is a pattern plus a name, and the name is the thing an operator actually
// knows.
//
// Usage, from the repository root:
//
//   node infra/clean-test-buckets.mjs --dry-run
//   node infra/clean-test-buckets.mjs
//
// Reads S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY and optionally S3_BUCKET,
// the same names apps/{api,worker,runner}/src/config.ts read.
//
// NOT HANDLED, and stated rather than assumed: object VERSIONS. The compose
// MinIO has versioning off, so one ListObjectsV2 pass empties a bucket. On a
// versioned bucket DeleteBucket would fail with BucketNotEmpty -- loudly,
// which is the right way to find out.

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

// The SDK is a dependency of @perfportal/storage, not of the root, and pnpm
// does not hoist -- so a bare `import '@aws-sdk/client-s3'` FROM THIS
// DIRECTORY fails with ERR_MODULE_NOT_FOUND however it is invoked. Node
// resolves a bare specifier relative to the importing FILE, so running with
// `pnpm --filter @perfportal/storage exec` does not help either: it changes
// the working directory, which resolution does not consult. Anchoring a
// require at that package's own manifest is what actually resolves it.
const require = createRequire(
  new URL('../packages/storage/package.json', import.meta.url),
);

const {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} = require('@aws-sdk/client-s3');

const TEST_BUCKET =
  /^test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const REAL_BUCKET = process.env.S3_BUCKET ?? 'perfportal';
const DRY_RUN = process.argv.includes('--dry-run');

const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'perfportal',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'perfportal123',
  },
  // MinIO serves buckets as a path segment, not as a DNS prefix.
  forcePathStyle: true,
});

// `DeleteObjects` FAILS AGAINST THIS MinIO WITHOUT AN EXPLICIT Content-MD5.
// The compose image (RELEASE.2024-09-13) still enforces the legacy
// requirement; aws-sdk 3.1105.0 sends a CRC32 trailer instead and the server
// answers `MissingContentMD5: Missing required header for this request:
// Content-Md5.` -- with nothing deleted. Measured: the documented client
// option `requestChecksumCalculation: 'WHEN_REQUIRED'` does NOT fix it.
//
// Hashing the serialised body in a `build` middleware does, verified at 1000
// objects in one request. The alternative is one DeleteObject per key, which
// needs no MD5 and would have meant ~120k round trips here.
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

/** Delete every object in a bucket. DeleteBucket refuses a non-empty one. */
async function emptyBucket(Bucket) {
  let deleted = 0;
  let ContinuationToken;

  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket, ContinuationToken }),
    );
    const objects = (page.Contents ?? []).map((o) => ({ Key: o.Key }));

    if (objects.length > 0) {
      // DeleteObjects caps at 1000 keys, which is also ListObjectsV2's default
      // page size -- so one page is always one legal request.
      const res = await client.send(
        new DeleteObjectsCommand({ Bucket, Delete: { Objects: objects } }),
      );
      if (res.Errors?.length) {
        throw new Error(
          `${Bucket}: ${res.Errors.length} object(s) would not delete, first: ` +
            `${res.Errors[0].Key} ${res.Errors[0].Code}`,
        );
      }
      deleted += objects.length;
    }

    // NextContinuationToken, not IsTruncated: a truncated page always carries
    // one, and looping on IsTruncated alone spins forever if it does not.
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);

  return deleted;
}

const { Buckets = [] } = await client.send(new ListBucketsCommand({}));

const targets = Buckets.map((b) => b.Name).filter(
  (name) => TEST_BUCKET.test(name) && name !== REAL_BUCKET,
);

const skipped = Buckets.length - targets.length;
console.log(
  `${Buckets.length} bucket(s); ${targets.length} match test-<uuid>, ${skipped} left alone` +
    (DRY_RUN ? ' [DRY RUN]' : ''),
);

let objects = 0;
for (const name of targets) {
  if (DRY_RUN) {
    console.log(`  would remove ${name}`);
    continue;
  }
  objects += await emptyBucket(name);
  await client.send(new DeleteBucketCommand({ Bucket: name }));
  console.log(`  removed ${name}`);
}

if (!DRY_RUN) {
  console.log(`done: ${targets.length} bucket(s), ${objects} object(s)`);
}
