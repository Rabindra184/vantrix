import { createHash } from 'node:crypto';
import { AGENT_BUNDLE_FILE, type BundleSource } from '@perfportal/core';
import type { RunRecord } from '@perfportal/persistence';
import { AgentFileError, decodeAgentFile, findSimulationLog, type AgentFile } from '@perfportal/plugin-gatling';
import {
  buildAgentFigures,
  runSeriesWidthMs,
  type AgentFigures,
  type EngineResult,
} from '@perfportal/statistics';
import type { BlobStore } from '@perfportal/storage';
import { isTransient } from './retry.js';

/**
 * ═══ A RUN'S AGENT FILE, AND THE RULE THAT IT NEVER FAILS THE RUN ═══
 *
 * The agent's file is extra evidence beside `simulation.log`, not part of the
 * run's own ingest. So every way it can be absent or wrong — never written,
 * deleted, a checksum that does not match, bytes that do not decode — ends as
 * an answer here (`none`, or `unreadable` with a reason `run_agent` records),
 * and the run's own statistics, verdict and status go on exactly as before.
 *
 * The ONE exception is a transient transport error reading the stored object:
 * that is rethrown, so the run retries the way it does for the same error on
 * its own log, rather than losing figures to a network blip for good.
 */
export type AgentSource =
  | { kind: 'none' }
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'unreadable'; reason: string };

export type AgentRun = Pick<RunRecord, 'agentLogKey' | 'agentLogSha256' | 'rawLogDeletedAt'>;

/** The SDK's two spellings of an absent object (`GetObject`'s and a bare 404). */
function isObjectMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'NoSuchKey' || err.name === 'NotFound') return true;
  return (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Where a run's agent file is, in order:
 *
 * 1. The object the on-prem runner stored (`agentLogKey`), unless retention
 *    has deleted it — after which the key names a deleted object, so it is
 *    gated on `rawLogDeletedAt` and never on the key alone. Verified against
 *    `agentLogSha256` as the run's own log is against `bundleSha256`.
 * 2. An entry named `AGENT_BUNDLE_FILE` in the SAME directory as the
 *    `simulation.log` the Gatling plugin parses (`findSimulationLog`, the
 *    plugin's own rule) — so a bundle holding several result directories pairs
 *    the log with its own agent file and never another run's. A live run's
 *    source is the raw log alone, so it never has one.
 * 3. Nothing.
 *
 * Used by the ingest pipeline and by the verifier, so both read the one file.
 */
export async function openAgentSource(
  run: AgentRun,
  deps: { blobs: BlobStore },
  bundle: BundleSource,
): Promise<AgentSource> {
  if (run.agentLogKey !== null && run.rawLogDeletedAt === null) {
    let bytes: Buffer;
    try {
      // HEAD first, as `openRunSource` does: an absent object is an answer,
      // not an exception to classify.
      if (!(await deps.blobs.exists(run.agentLogKey))) return { kind: 'unreadable', reason: 'missing' };
      bytes = await deps.blobs.get(run.agentLogKey);
    } catch (err) {
      if (isTransient(err)) throw err;
      // Deleted between the HEAD and the GET.
      if (isObjectMissing(err)) return { kind: 'unreadable', reason: 'missing' };
      return { kind: 'unreadable', reason: `read_failed: ${messageOf(err)}` };
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== run.agentLogSha256) return { kind: 'unreadable', reason: 'checksum_mismatch' };
    return { kind: 'bytes', bytes };
  }

  const log = findSimulationLog(bundle.index.files);
  if (log === undefined) return { kind: 'none' };
  const slash = log.lastIndexOf('/');
  const entry = slash < 0 ? AGENT_BUNDLE_FILE : `${log.slice(0, slash)}/${AGENT_BUNDLE_FILE}`;
  if (!bundle.index.files.includes(entry)) return { kind: 'none' };
  try {
    return { kind: 'bytes', bytes: await bundle.read(entry) };
  } catch (err) {
    if (isTransient(err)) throw err;
    return { kind: 'unreadable', reason: `read_failed: ${messageOf(err)}` };
  }
}

export type AgentOutcome =
  | { kind: 'none' }
  | { kind: 'collected'; file: AgentFile; figures: AgentFigures }
  | { kind: 'unreadable'; reason: string };

/**
 * Decodes the agent file and builds its figures on the run's own time axis and
 * series width. Never throws: an undecodable file is `unreadable` with the
 * decoder's own message, and a run whose log header carried no start has no
 * origin to place a record against, so it is `unreadable` too rather than
 * measured against the Unix epoch.
 */
export function agentOutcome(source: AgentSource, result: EngineResult): AgentOutcome {
  if (source.kind !== 'bytes') return source;
  if (result.runStartedAtMs === null) return { kind: 'unreadable', reason: 'no run start' };
  let file: AgentFile;
  try {
    file = decodeAgentFile(source.bytes);
  } catch (err) {
    if (err instanceof AgentFileError) return { kind: 'unreadable', reason: `undecodable: ${err.message}` };
    return { kind: 'unreadable', reason: `undecodable: ${messageOf(err)}` };
  }
  try {
    const figures = buildAgentFigures(file, {
      runStartMs: result.runStartedAtMs,
      durationMs: result.durationMs,
      bucketWidthMs: runSeriesWidthMs(result),
    });
    return { kind: 'collected', file, figures };
  } catch (err) {
    // A defect in the builder is not the file's fault, and still must not fail
    // the run: it is recorded, and logged so it is not silent.
    console.error('agent figures could not be built:', err);
    return { kind: 'unreadable', reason: `figures_failed: ${messageOf(err)}` };
  }
}
