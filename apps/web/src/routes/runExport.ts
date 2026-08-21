import type { Assertion, RunIdentity, RunResponse } from '@perfportal/contracts';
import { downloadBlob } from '../download';

export type RunSummaryExport = {
  readonly exportedAt: string;
  readonly run: Partial<RunIdentity> & {
    readonly id: string;
    readonly status: RunResponse['status'];
    readonly verdict: RunResponse['verdict'] | undefined;
  };
  readonly assertions?: readonly Assertion[];
};

/**
 * The decision band's own contents as a file: the run's identity, the state
 * it was in, and the SLA rules that produced (or did not produce) its
 * verdict.
 *
 * `assertions` IS OMITTED, NOT EMPTIED, when the caller has none to give.
 * `undefined` there means "this run has not been evaluated" — the same
 * distinction `verdict: undefined` draws — and an empty array would assert
 * that it was evaluated and produced no rules, which is a different fact.
 *
 * `exportedAt` is a parameter with a default rather than a bare
 * `new Date()` so a test can pin it.
 */
export function runSummaryJson({
  identity,
  status,
  verdict,
  assertions,
  exportedAt = new Date().toISOString(),
}: {
  readonly identity: Partial<RunIdentity> & { readonly id: string };
  readonly status: RunResponse['status'];
  readonly verdict: RunResponse['verdict'] | undefined;
  readonly assertions?: readonly Assertion[];
  readonly exportedAt?: string;
}): string {
  const payload: RunSummaryExport = {
    exportedAt,
    run: { ...identity, status, verdict },
    ...(assertions === undefined ? {} : { assertions }),
  };

  return JSON.stringify(payload, null, 2);
}

/** `downloadBlob` with this format's own MIME type; see `../download`. */
export function downloadRunSummary(filename: string, json: string): void {
  downloadBlob(filename, new Blob([json], { type: 'application/json;charset=utf-8' }));
}
