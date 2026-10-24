import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENT_BUNDLE_FILE, type BundleSource } from '@perfportal/core';
import type { EngineResult } from '@perfportal/statistics';
import type { BlobStore } from '@perfportal/storage';
import { describe, expect, it } from 'vitest';
import { agentOutcome, openAgentSource } from '../src/pipeline/agent-source.js';

const AGENT = readFileSync(
  fileURLToPath(new URL('../../../fixtures/gatling-3.15.1.2/agent-run/agent.ndjson', import.meta.url)),
);
const KEY = 'runs/r1/agent.ndjson';
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/**
 * The two `BlobStore` methods `openAgentSource` reaches. `fail` replaces a
 * `get` with a thrown error, so a transport failure can be told apart from a
 * missing object.
 */
function fakeBlobs(objects: Record<string, Buffer>, fail?: Error): BlobStore & { gets: string[] } {
  const gets: string[] = [];
  return {
    gets,
    exists: async (key: string) => key in objects,
    get: async (key: string) => {
      gets.push(key);
      if (fail) throw fail;
      const body = objects[key];
      if (!body) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
      return body;
    },
  } as unknown as BlobStore & { gets: string[] };
}

/** A results bundle holding `files`; every entry reads as `entries[path]` or empty bytes. */
function bundle(files: string[], entries: Record<string, Uint8Array> = {}): BundleSource {
  return {
    index: { files, head: async () => new Uint8Array() },
    read: async (path) => {
      if (!files.includes(path)) throw new Error(`no such entry: ${path}`);
      return entries[path] ?? new Uint8Array();
    },
  };
}

const NO_BUNDLE = bundle(['simulation.log']);
const stored = { agentLogKey: KEY, agentLogSha256: sha256(AGENT), rawLogDeletedAt: null };
const none = { agentLogKey: null, agentLogSha256: null, rawLogDeletedAt: null };
/** A retry will come back for the run: a transient read error is rethrown. */
const RETRY = { rethrowTransient: true };
/** The last attempt: nothing comes back, so the same error is recorded. */
const LAST = { rethrowTransient: false };

describe('openAgentSource', () => {
  it('reads the stored object when its checksum matches', async () => {
    const blobs = fakeBlobs({ [KEY]: AGENT });
    const source = await openAgentSource(stored, { blobs }, NO_BUNDLE, RETRY);
    expect(source.kind).toBe('bytes');
    expect(source.kind === 'bytes' && Buffer.from(source.bytes).equals(AGENT)).toBe(true);
  });

  it('refuses bytes that differ from the recorded checksum', async () => {
    const blobs = fakeBlobs({ [KEY]: AGENT });
    const source = await openAgentSource(
      { ...stored, agentLogSha256: 'a'.repeat(64) },
      { blobs },
      NO_BUNDLE,
      RETRY,
    );
    expect(source).toEqual({ kind: 'unreadable', reason: 'checksum_mismatch' });
  });

  it('reports a stored object that is gone as missing', async () => {
    const source = await openAgentSource(stored, { blobs: fakeBlobs({}) }, NO_BUNDLE, RETRY);
    expect(source).toEqual({ kind: 'unreadable', reason: 'missing' });
  });

  it('rethrows a transport error, so the run retries rather than losing its figures', async () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    await expect(openAgentSource(stored, { blobs: fakeBlobs({ [KEY]: AGENT }, reset) }, NO_BUNDLE, RETRY)).rejects.toBe(
      reset,
    );
  });

  it('records a transport error on the last attempt instead of failing the run over its agent file', async () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const source = await openAgentSource(stored, { blobs: fakeBlobs({ [KEY]: AGENT }, reset) }, NO_BUNDLE, LAST);
    expect(source).toEqual({ kind: 'unreadable', reason: 'read_failed: socket hang up' });
  });

  it('records a non-transport read failure instead of failing the run', async () => {
    const denied = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
    const source = await openAgentSource(stored, { blobs: fakeBlobs({ [KEY]: AGENT }, denied) }, NO_BUNDLE, RETRY);
    expect(source).toEqual({ kind: 'unreadable', reason: 'read_failed: Access Denied' });
  });

  it('does not read a stored object retention has deleted, and falls to the bundle', async () => {
    const blobs = fakeBlobs({ [KEY]: AGENT });
    const source = await openAgentSource(
      { ...stored, rawLogDeletedAt: new Date('2026-10-01T00:00:00Z') },
      { blobs },
      bundle(['run-1/simulation.log', `run-1/${AGENT_BUNDLE_FILE}`], { [`run-1/${AGENT_BUNDLE_FILE}`]: AGENT }),
      RETRY,
    );
    expect(blobs.gets).toEqual([]);
    expect(source.kind === 'bytes' && Buffer.from(source.bytes).equals(AGENT)).toBe(true);
  });

  it('reads the bundle entry beside the simulation.log the plugin selects', async () => {
    const source = await openAgentSource(
      none,
      { blobs: fakeBlobs({}) },
      bundle(['run-1/simulation.log', `run-1/${AGENT_BUNDLE_FILE}`], { [`run-1/${AGENT_BUNDLE_FILE}`]: AGENT }),
      RETRY,
    );
    expect(source.kind === 'bytes' && Buffer.from(source.bytes).equals(AGENT)).toBe(true);
  });

  it('reads a top-level entry beside a top-level simulation.log', async () => {
    const source = await openAgentSource(
      none,
      { blobs: fakeBlobs({}) },
      bundle(['simulation.log', AGENT_BUNDLE_FILE], { [AGENT_BUNDLE_FILE]: AGENT }),
      RETRY,
    );
    expect(source.kind).toBe('bytes');
  });

  it('ignores an entry of that name in another directory', async () => {
    const source = await openAgentSource(
      none,
      { blobs: fakeBlobs({}) },
      bundle(['run-1/simulation.log', `other/${AGENT_BUNDLE_FILE}`, AGENT_BUNDLE_FILE]),
      RETRY,
    );
    expect(source).toEqual({ kind: 'none' });
  });

  it('answers none when there is neither an object nor an entry', async () => {
    expect(await openAgentSource(none, { blobs: fakeBlobs({}) }, NO_BUNDLE, RETRY)).toEqual({ kind: 'none' });
  });
});

/** Only the fields `agentOutcome` reads. */
function result(runStartedAtMs: number | null): EngineResult {
  return { runStartedAtMs, durationMs: 3_625, series: new Map() } as unknown as EngineResult;
}

describe('agentOutcome', () => {
  it('builds figures from decodable bytes', () => {
    const out = agentOutcome({ kind: 'bytes', bytes: AGENT }, result(1_792_800_316_284));
    expect(out.kind).toBe('collected');
    expect(out.kind === 'collected' && out.figures.bucketWidthMs).toBe(1000);
  });

  it('records an undecodable file with the decoder’s own message', () => {
    const out = agentOutcome({ kind: 'bytes', bytes: Buffer.from('not json\n') }, result(1_792_800_316_284));
    expect(out.kind).toBe('unreadable');
    expect(out.kind === 'unreadable' && out.reason).toMatch(/^undecodable: /);
  });

  it('records a run with no start as unreadable rather than placing records against epoch', () => {
    expect(agentOutcome({ kind: 'bytes', bytes: AGENT }, result(null))).toEqual({
      kind: 'unreadable',
      reason: 'no run start',
    });
  });

  it('passes none and unreadable through', () => {
    expect(agentOutcome({ kind: 'none' }, result(1))).toEqual({ kind: 'none' });
    expect(agentOutcome({ kind: 'unreadable', reason: 'missing' }, result(1))).toEqual({
      kind: 'unreadable',
      reason: 'missing',
    });
  });
});
