import { formatClockTime, formatDuration, formatZoneOffset } from './format';
import { STEP_LABEL, type LifecycleStep, type StepState } from './lifecycle';
import { Marked, VERDICT, type Mark } from './marks';

/**
 * ═══ THE RUN'S JOURNEY, UNDER ITS NAME ═══
 * (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md)
 *
 * Gatling Enterprise opens a run with `Build successful ❯ Deployed · 14s ❯
 * Assertions failed · 2m 00s`; this is that shape with PerfPortal's own steps.
 *
 * NO HEADING. `RunShell` renders above the tab outlet, so anything here is on
 * every tab, and the Overview tab's heading outline is asserted as an exact
 * list. Named by `aria-label`, like `LiveStatusStrip` and the decision band.
 *
 * STEP TIMES SIT BESIDE THE LIST, NEVER INSIDE A `<summary>`: a summary's
 * contents are presentational to a screen reader, so a list there would lose
 * its list-ness. Times are absolute; the Offset/Datetime axis mode does not
 * touch them.
 *
 * ONE DECISION, ONE BREAKPOINT. `compact` (`useIsCompact`, below 768 px)
 * chooses both WHAT the strip says and HOW it is drawn, rather than a Tailwind
 * `md:` variant answering the second half on its own — review M02's rule that
 * a JS breakpoint and a CSS breakpoint describing one decision must be one
 * number. On a phone it is ONE bare line: the fold had 10 px to spare, and a
 * carded row would have pushed the run's own numbers off the first screen.
 */

/** A state's glyph and colour — the run list's own shapes (`marks.tsx`). */
const STATE_MARK: Record<StepState, Omit<Mark, 'label'>> = {
  done: { glyph: '●', colour: 'var(--color-status-passed)' },
  active: { glyph: '◐', colour: 'var(--color-status-pending)' },
  pending: { glyph: '○', colour: 'var(--color-status-not-applicable)' },
  stopped: { glyph: '◌', colour: 'var(--color-status-not-applicable)' },
  failed: { glyph: '✕', colour: 'var(--color-status-failed)' },
};

const FRAME =
  'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 rounded-xl border border-default bg-surface px-4 py-3 text-[0.8125rem]';
const COMPACT_FRAME = 'flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[0.75rem] leading-4';

function markFor(step: LifecycleStep): Mark {
  // The Verdict step wears the verdict's own mark, as the run list does.
  if (step.name === 'verdict' && step.state !== 'pending') {
    const verdict = VERDICT[step.verdict ?? 'none'];
    return { glyph: verdict.glyph, colour: verdict.colour, label: step.text };
  }
  return { ...STATE_MARK[step.state], label: step.text };
}

/**
 * THE ONE STEP A PHONE SHOWS, in the order a reader needs it:
 *   1. a step that did not end well — on an incomplete run "Load test stopped
 *      early" is the news, and since the decision band gave up its Execution
 *      row this line is the only place a phone can still say it;
 *   2. the step in progress — where the run is now;
 *   3. the Load test, once done — what the run did, whose Duration chip a
 *      phone folds behind "Run details" (review M02);
 *   4. otherwise the furthest step reached.
 * Never the verdict: that is the decision band's 36 px word directly below.
 *
 * "The furthest step reached" alone was the first rule, and the whole-branch
 * review measured it wrong twice: an incomplete run's Processing step always
 * outranks its Load test, so a phone read "Nothing retained", or a green
 * "Processed · 2s" over a run whose partial log carried a real Passed verdict,
 * and nothing on the first screen said the test had been cut short.
 */
function phoneStep(steps: readonly LifecycleStep[]): LifecycleStep[] {
  const candidates = steps.filter((s) => s.name !== 'verdict');
  const reached = candidates.filter((s) => s.state !== 'pending');
  const chosen =
    candidates.find((s) => s.state === 'stopped' || s.state === 'failed') ??
    candidates.find((s) => s.state === 'active') ??
    candidates.find((s) => s.name === 'load-test' && s.state === 'done') ??
    reached[reached.length - 1] ??
    steps[0];
  return chosen === undefined ? [] : [chosen];
}

/** A calendar day in the reader's zone. Built per call: a module-scope
 *  `Intl.DateTimeFormat` freezes the zone at import (CLAUDE.md). */
function formatDay(epochMs: number): string {
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(epochMs);
}

/** A time of day, dated only when its day differs from the caption's. */
function timeCell(epochMs: number | null, anchorMs: number | null): string {
  if (epochMs === null) return '—';
  const time = formatClockTime(epochMs);
  return anchorMs !== null && formatDay(epochMs) !== formatDay(anchorMs) ? `${formatDay(epochMs)} ${time}` : time;
}

export default function RunLifecycle({
  steps,
  compact,
}: {
  readonly steps: readonly LifecycleStep[];
  readonly compact: boolean;
}) {
  const shown = compact ? phoneStep(steps) : steps;
  const anchorMs = steps.find((s) => s.startMs !== null)?.startMs ?? null;

  return (
    <section aria-label="Run lifecycle" data-testid="run-lifecycle" className={compact ? COMPACT_FRAME : FRAME}>
      <ol className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {shown.map((step, i) => (
          <li
            key={step.name}
            data-testid={`lifecycle-${step.name}`}
            data-state={step.state}
            className="flex min-w-0 items-center gap-2"
          >
            {i > 0 ? (
              <span aria-hidden="true" className="text-muted">
                ❯
              </span>
            ) : null}
            <Marked mark={markFor(step)} />
          </li>
        ))}
      </ol>

      <details data-testid="lifecycle-times" className="min-w-0 text-[0.75rem]">
        {/* The disclosure affordance every other `<summary>` in this app wears
            (`TableFrame`, `RunStats`, `StatisticsTable`): accent, underline on
            hover, no marker. */}
        <summary className="w-fit cursor-pointer list-none font-medium text-accent hover:underline hover:underline-offset-2">
          Step times
        </summary>
        <table className="mt-2 border-collapse text-left">
          <caption className="pb-1 text-left text-muted">
            {anchorMs === null
              ? 'No times recorded yet'
              : `Times on ${formatDay(anchorMs)}, ${formatZoneOffset(anchorMs)}`}
          </caption>
          <thead>
            <tr className="text-muted">
              <th scope="col" className="pr-4 font-medium">Step</th>
              <th scope="col" className="pr-4 font-medium">Started</th>
              <th scope="col" className="pr-4 font-medium">Ended</th>
              <th scope="col" className="font-medium">Took</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {steps.map((step) => (
              <tr key={step.name} data-testid={`lifecycle-times-${step.name}`}>
                <th scope="row" className="pr-4 font-sans font-normal">{STEP_LABEL[step.name]}</th>
                <td className="pr-4">{timeCell(step.startMs, anchorMs)}</td>
                <td className="pr-4">{timeCell(step.endMs, anchorMs)}</td>
                <td>{step.durationMs !== null ? formatDuration(step.durationMs) : (step.note ?? '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
