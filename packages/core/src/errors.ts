export type IngestErrorCode =
  | 'BUNDLE_TOO_LARGE' | 'BUNDLE_NOT_ARCHIVE' | 'BUNDLE_EMPTY'
  | 'TOOL_AMBIGUOUS' | 'TOOL_UNKNOWN'
  | 'LOG_NOT_FOUND' | 'LOG_BINARY_FORMAT' | 'LOG_MALFORMED'
  | 'ENDPOINT_CARDINALITY_EXCEEDED' | 'NO_REQUESTS'
  | 'PROJECT_MISMATCH' | 'TOKEN_REVOKED'
  | 'PLUGIN_TIMEOUT' | 'PLUGIN_MEMORY_EXCEEDED';

export class IngestError extends Error {
  readonly code: IngestErrorCode;
  /** Required. An error that cannot state a fix will not compile. */
  readonly remediation: string;
  readonly detail?: Record<string, unknown>;

  constructor(code: IngestErrorCode, opts: { message: string; remediation: string; detail?: Record<string, unknown> }) {
    super(opts.message);
    this.name = 'IngestError';
    this.code = code;
    this.remediation = opts.remediation;
    this.detail = opts.detail;
  }
}

export function ingestError(
  code: IngestErrorCode,
  opts: { message: string; remediation: string; detail?: Record<string, unknown> },
): IngestError {
  return new IngestError(code, opts);
}
