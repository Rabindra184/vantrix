import type { Assertion, RunIdentity, RunResponse } from '@perfportal/contracts';

export type RunSummaryExport = {
  readonly exportedAt: string;
  readonly run: Partial<RunIdentity> & {
    readonly id: string;
    readonly status: RunResponse['status'];
    readonly verdict: RunResponse['verdict'] | undefined;
  };
  readonly assertions?: readonly Assertion[];
};

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

export function downloadRunSummary(filename: string, json: string): void {
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
