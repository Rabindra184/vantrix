import type { CapabilityDescriptor } from './capabilities.js';
import type { CanonicalEvent, ToolId } from './events.js';

/**
 * A read-only view of an opened bundle. The WORKER implements this; a plugin
 * never opens a file or reaches object storage itself. That is what lets the
 * plugin declare an async contract while staying inside the purity rule
 * (no node:fs, no I/O) that ESLint enforces on this package.
 */
export interface BundleIndex {
  /** Bundle-relative paths with POSIX separators. */
  readonly files: readonly string[];
  /** First `bytes` bytes of a file, for signature sniffing. Never the whole file. */
  head(path: string, bytes: number): Promise<Uint8Array>;
}

export interface BundleSource {
  readonly index: BundleIndex;
  read(path: string): Promise<Uint8Array>;
}

export interface DetectResult {
  matched: boolean;
  /** Tool version as reported by the bundle, when the format carries one. */
  toolVersion?: string;
  /** Populated when matched is false, to explain what was expected. */
  reason?: string;
}

export interface PerfPlugin {
  readonly id: ToolId;
  detect(index: BundleIndex): Promise<DetectResult>;
  /**
   * Async by contract even where an implementation is synchronous underneath.
   * This is the seam at which a streaming reader can later be substituted
   * without changing the engine or any consumer (spec §5.1).
   */
  parse(source: BundleSource): AsyncIterable<CanonicalEvent>;
  capabilities(): CapabilityDescriptor;
}
