import {
  ingestError,
  type BundleIndex,
  type BundleSource,
  type CanonicalEvent,
  type CapabilityDescriptor,
  type DetectResult,
  type PerfPlugin,
  type ToolId,
} from '@perfportal/core';
import { RECORD, readRunHeader } from './header.js';
import { BinaryReader } from './reader.js';
import { parseSimulationLog } from './records.js';

export const SIMULATION_LOG = 'simulation.log';

/**
 * The binary log format carries no compatibility guarantee across Gatling
 * majors (PRD §28 R-3). An unknown major is rejected, never parsed on a guess:
 * a wrong record layout does not fail loudly, it produces plausible wrong
 * numbers, which is the worst outcome this product can have.
 */
export const SUPPORTED_GATLING_MAJORS: readonly string[] = ['3'];

/** Enough for the record byte plus the length-prefixed version string. */
const HEAD_BYTES = 64;

function findLog(index: BundleIndex): string | undefined {
  return index.files.find((f) => f === SIMULATION_LOG || f.endsWith(`/${SIMULATION_LOG}`));
}

export class GatlingPlugin implements PerfPlugin {
  readonly id: ToolId = 'gatling';

  async detect(index: BundleIndex): Promise<DetectResult> {
    const path = findLog(index);
    if (!path) {
      return { matched: false, reason: `no ${SIMULATION_LOG} found in the bundle` };
    }

    const head = await index.head(path, HEAD_BYTES);
    const buf = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
    if (buf.length < 5 || buf.readInt8(0) !== RECORD.RUN) {
      return {
        matched: false,
        reason: `${path} does not begin with a Gatling Run record (0x00)`,
      };
    }

    const len = buf.readInt32BE(1);
    if (len <= 0 || 5 + len > buf.length) {
      return { matched: false, reason: `${path} has an unreadable version header` };
    }
    const version = buf.subarray(5, 5 + len).toString('latin1');
    const major = version.split('.')[0] ?? '';
    if (!SUPPORTED_GATLING_MAJORS.includes(major)) {
      return {
        matched: false,
        reason: `Gatling ${version} is not a supported major (supported: ${SUPPORTED_GATLING_MAJORS.join(', ')})`,
      };
    }
    return { matched: true, toolVersion: version };
  }

  async *parse(source: BundleSource): AsyncIterable<CanonicalEvent> {
    const path = findLog(source.index);
    if (!path) {
      throw ingestError('LOG_NOT_FOUND', {
        message: `The bundle contains no ${SIMULATION_LOG}.`,
        remediation: `Upload the whole Gatling results directory, which contains ${SIMULATION_LOG}. Uploading only the HTML report is not enough — the report is rendered output, not data.`,
        detail: { files: source.index.files.slice(0, 20) },
      });
    }

    const bytes = await source.read(path);
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Re-read the header for a precise version error before streaming records.
    const version = readRunHeader(new BinaryReader(buf)).gatlingVersion;
    const major = version.split('.')[0] ?? '';
    if (!SUPPORTED_GATLING_MAJORS.includes(major)) {
      throw ingestError('LOG_BINARY_FORMAT', {
        message: `Gatling ${version} writes a simulation.log layout this build does not support.`,
        remediation: `Re-run with a supported Gatling major (${SUPPORTED_GATLING_MAJORS.join(', ')}), or upgrade the platform to a build that lists this version as supported.`,
        detail: { version },
      });
    }

    try {
      yield* parseSimulationLog(buf);
    } catch (err) {
      if (err instanceof Error && err.name === 'IngestError') throw err;
      throw ingestError('LOG_MALFORMED', {
        message: `simulation.log could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
        remediation:
          'The file appears truncated or corrupt. Confirm the Gatling run finished and that the whole results directory was archived without modification.',
        detail: { path },
      });
    }
  }

  capabilities(): CapabilityDescriptor {
    return {
      latency: false,          // the binary log records start/end only, not first-byte
      groups: true,
      scenarios: true,
      sessionEvents: true,
      nativeAssertions: true,  // present as opaque protobuf; decoded in M3
      errorMessages: true,
    };
  }
}
