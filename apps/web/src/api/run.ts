import {
  RunProcessingSchema,
  RunResponseSchema,
  type RunProcessing,
  type RunResponse,
} from '@perfportal/contracts';
import { problemFrom } from './fetch';

/**
 * One run, in whichever of its two READABLE shapes the API answered with.
 *
 * A discriminated union rather than a nullable `RunResponse`, because the two
 * are not the same thing with fields missing: a processing run has no
 * duration, no verdict and no assertions, and there is no honest value to
 * render for them. `state` is what lets the page say "still processing"
 * instead of "0s / no verdict / no assertions", which reads as facts about a
 * run nobody has looked at yet.
 */
export type RunDetail =
  | { state: 'ready'; run: RunResponse }
  | { state: 'processing'; run: RunProcessing };

/**
 * ONE query key for a single run, a FUNCTION of the id — exported beside its
 * fetcher exactly as `runsQueryKey` is beside `fetchRuns`, so a consumer that
 * needs to read or invalidate one run's cache names the same array this
 * module does.
 *
 * Deliberately NOT under `['runs', ...]`: that prefix is the list's, keyed by
 * cursor, and colliding the two would make an invalidation of the list also
 * discard every run detail the user has open.
 */
export const runQueryKey = (id: string) => ['run', id] as const;

/**
 * How often a processing run is re-asked for.
 *
 * The API sends `Retry-After: 5` with every 202 (respondWithRun's
 * `retryAfterSeconds` default), and this mirrors it. It is not READ off the
 * response: carrying it would mean widening `RunDetail` with a transport
 * detail that only this one constant consumes, and the header's value is
 * fixed in the API's own source rather than negotiated. If it ever becomes
 * dynamic, read it there and widen the type then.
 */
export const POLL_INTERVAL_MS = 5_000;

/**
 * How long polling continues before it gives up and asks the reader instead.
 *
 * A run that never settles — a worker that died mid-parse, a queue nobody is
 * consuming — would otherwise be re-fetched every five seconds for as long as
 * the tab is open, which is a background tab making requests until it is
 * closed. Two minutes is long enough that no ordinary parse is interrupted
 * and short enough that a forgotten tab stops being a client of the API.
 */
export const POLL_CAP_MS = 120_000;

/**
 * The polling decision, as a pure function.
 *
 * Extracted from the component on purpose: the interesting case is the CAP,
 * and the cap cannot be reached inside a browser test without waiting two
 * real minutes (`seedPendingRun` creates a run no worker will ever pick up,
 * so there is nothing to wait ON — only elapsed time). Deciding it here means
 * it is covered where the decision is made, by a unit test that passes the
 * elapsed state in directly.
 *
 * `detail === undefined` — the query has no data, i.e. it is still loading or
 * it failed BEFORE ever succeeding — returns false rather than an interval.
 * That is what stops a run that 404s or 500s on first load from being
 * re-requested every five seconds forever.
 *
 * It is NOT a general guard against polling a failing endpoint, and this
 * docstring used to claim otherwise. TanStack Query retains `state.data`
 * across a later error, so a run that fetched once as `processing` and then
 * started failing still arrives here with a defined `detail` whose state is
 * `processing`, and keeps being re-asked. The CAP is what ends that — which
 * is the second reason POLL_CAP_MS exists, alongside the never-settling run
 * its own comment describes.
 */
export function pollIntervalFor(detail: RunDetail | undefined, capReached: boolean): number | false {
  if (capReached) return false;
  if (detail === undefined) return false;
  return detail.state === 'processing' ? POLL_INTERVAL_MS : false;
}

/**
 * `GET /v1/runs/:id` — org-scoped by the session cookie, like every other
 * read in this app.
 *
 * NOT routed through `apiFetch`, and this is the exception that proves that
 * function's rule. `apiFetch` rejects every non-2xx as a `ProblemError`,
 * which is correct for `/v1` generally — but this one endpoint answers with
 * THREE different bodies across three status classes
 * (RunsService.statusFor, apps/api/src/runs/runs.controller.ts):
 *
 *   200  complete, verdict passed or not_evaluated  → a run body
 *   422  complete, verdict FAILED                   → a run body
 *   202  pending / parsing                          → a RunProcessing body
 *   4xx  ingest failed, or no such run in this org  → problem+json
 *
 * `apiFetch` is left alone: three other tasks depend on its guarantee, and
 * weakening it for one endpoint would weaken it everywhere. The endpoint gets
 * its own reader instead — but it reuses `problemFrom` for the error path, so
 * there is still exactly one piece of code in this app that knows how to read
 * a problem document.
 */
export async function fetchRun(id: string): Promise<RunDetail> {
  const res = await fetch(`/v1/runs/${encodeURIComponent(id)}`, { credentials: 'same-origin' });

  // 422 is a VERDICT, not a transport failure. The run parsed perfectly, was
  // measured against its SLA rules, and failed one — and the body is a
  // complete, ordinary run. Treating this status as an error is the single
  // most damaging thing this file could do: an SLA-failed run is among the
  // most important runs anyone opens, and the reader would be told it could
  // not be read at all. It is grouped with 200 deliberately; the failed
  // verdict shows in the header, which is where a verdict belongs.
  if (res.status === 200 || res.status === 422) {
    return { state: 'ready', run: RunResponseSchema.parse(await res.json()) };
  }

  // 202 is the run not being finished yet, not an error either. Same
  // treatment as apiFetch's success path from here: the contract schema is
  // left to throw if the body does not match, because a 2xx the schema
  // rejects is a bug rather than data.
  if (res.status === 202) {
    return { state: 'processing', run: RunProcessingSchema.parse(await res.json()) };
  }

  // Everything else IS an error, and goes through the one reader — a 404 for
  // a run in another org, a 400 for a bundle the ingest rejected, a 502 that
  // never reached the API at all.
  throw await problemFrom(res);
}
