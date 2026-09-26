import type { ReactNode } from 'react';
import { describeSlaOutcome } from '@perfportal/contracts';
import type { Assertion, RunIdentity, RunResponse } from '@perfportal/contracts';
import { Link } from 'react-router-dom';
import Badge from '../components/Badge';
import { CompareTabIcon, DownloadIcon } from '../components/icons';
import Button, { linkButtonClasses } from '../components/Button';
import { ASSERTION_OUTCOME, STATUS, VERDICT, type Mark } from './marks';
import { countAssertions, firstFailedAssertion, type AssertionCounts } from './assertions';
import { decisionOf, releaseWord, type Decision } from './decision';
import { runComparePath, runPath } from './paths';
import { downloadRunSummary, runSummaryJson } from './runExport';

/**
 * `unevaluated` IS NOT `none`, AND COLLAPSING THEM IS THE BUG `Decision`
 * (`decision.ts`) EXISTS TO PREVENT.
 *
 * `RunShell`'s `verdict` prop states the rule: "`undefined` means NOT
 * EVALUATED YET and omits the badge; `null` means evaluated with no
 * verdict." `RunHeader` has always honoured it — a pending or running run
 * gets no verdict badge at all, because "no verdict yet" reads as
 * evaluated-and-nothing-found, a claim about a run nobody has finished
 * measuring. This band shipped rendering `VERDICT.none` for BOTH, which put
 * that exact claim one element below the header that omits it.
 *
 * So `unevaluated` has no `Mark`: there is nothing honest to stamp.
 */

const DECISION: Record<Exclude<Decision, 'unevaluated'>, Mark> = {
  passed: VERDICT.passed,
  failed: VERDICT.failed,
  not_evaluated: VERDICT.not_evaluated,
  none: VERDICT.none,
};

export default function RunDecisionBand({
  identity,
  status,
  verdict,
  assertions,
  toolAssertions,
}: {
  readonly identity: Partial<RunIdentity> & { readonly id: string };
  readonly status: RunResponse['status'];
  readonly verdict: RunResponse['verdict'] | undefined;
  /**
   * `undefined` until the run has been evaluated — NOT an empty array. The
   * counts below are drawn only when this is present, for the same reason
   * `RunShell` passes `null` rather than `0` for an error count that has not
   * arrived: three zeros are three measurements, and nobody took them.
   */
  readonly assertions?: readonly Assertion[];
  /**
   * The simulation's OWN assertions, as the tool reported them.
   *
   * ═══ A DIFFERENT SYSTEM'S ANSWER, REPORTED BESIDE OURS ═══
   *
   * Both demo runs read "Not evaluated — 0 passed · 0 failed" because those
   * are PLATFORM-SLA counters and neither project had configured a rule. Both
   * also had failing assertions declared by the simulation itself, sitting far
   * below the fold. Short labels over one system's counters read as overall
   * test health, and an engineer deciding ship/no-ship read zero failures over
   * a run with one.
   *
   * So the band states its facts separately — platform gates and simulation
   * assertions, each in its own row; what the run itself did is now the
   * lifecycle strip's — rather than making one word
   * carry them. It deliberately does NOT fold these into the release verdict:
   * a platform gate is the organisation's policy and a simulation assertion is
   * the test author's, and merging them would make the gate mean something
   * nobody configured.
   *
   * `undefined` is a server that predates the field, `[]` is a simulation that
   * declared none — reported differently, because absence and emptiness are
   * different facts.
   */
  readonly toolAssertions?: RunResponse['toolAssertions'];
}) {
  /**
   * ═══ THE DISTINCTION `gatesText` ALREADY MADE, NOW MADE EVERYWHERE
   * (review 09-13 C01) ═══
   *
   * `evaluated` is `assertions !== undefined`, so an EMPTY array counts as
   * evaluated. The note on `gatesText` below already says why that is wrong
   * for a row of counts — nothing judging a run is not the same as nothing
   * failing — and fixed it for that row alone. Its two siblings, the counts
   * SENTENCE and the count TILES, kept reading `evaluated` and kept printing
   * three zeros.
   *
   * What that cost is the finding: for a run with no SLA rules and one failed
   * simulation check, the band said the same non-fact four times — the 48px
   * word, the badge beside it, "0 passed · 0 failed · 0 not applicable", and
   * "Passed 0 Failed 0 N/A 0" — while the actual failure appeared once, in
   * 12px, below all of it. A fast scan finds the zeros and misses the failure.
   */
  const judged = assertions !== undefined && assertions.length > 0;
  const counts = countAssertions(assertions ?? []);
  const simulation = summariseToolAssertions(toolAssertions);
  /* `evaluated` treats `[]` as evaluated, which is what produced "0 passed ·
     0 failed" over a project with no rules at all — three zeros that read as
     health. For THIS row the distinction is the whole point: an empty list
     means nothing judged the run, which is not the same as nothing failing. */
  const gatesText =
    assertions === undefined
      ? 'not reported yet'
      : assertions.length === 0
        ? 'not configured — no SLA rule judged this run'
        : `${counts.passed} passed · ${counts.failed} failed`;
  const failed = firstFailedAssertion(assertions ?? []);
  const decision: Decision = decisionOf(verdict);
  /* ═══ "Not configured" IS NOT "Not evaluated" (review 09-13 copy table) ═══
   *
   * The row is "Repeated Not evaluated block" -> "`SLA: Not configured`". The
   * 48px word read `Not evaluated` for two different facts: nothing judged
   * this run because the project has NO RULE, and rules existed and every one
   * came back not applicable. The first is a setup state the reader can act
   * on; the second is a real evaluation with nothing to say.
   *
   * `gatesText` two lines up has drawn that distinction since C01 — "not
   * configured — no SLA rule judged this run" — and the word above it
   * contradicted it. This is the same "grep for the siblings of a comment that
   * argues a distinction" lesson CLAUDE.md already records for this component,
   * met a third time.
   *
   * KEYED ON THE ARRAY, NOT ON `judged`. `judged` is false for BOTH an empty
   * list and an absent one, and an absent one is a run whose assertions have
   * not been reported yet — "Not configured" would be a claim about a project
   * we have not heard from. */
  // The expression this comment argues lives in `releaseWord` (`decision.ts`)
  // now, so the lifecycle strip's Verdict step reads the same word by calling
  // the same function, rather than by agreeing with a copy of it.
  const word = releaseWord(verdict, assertions);
  /* RENDERED FROM THE FIELDS, NOT THE STORED MESSAGE. `failed.message` is
     written by `packages/sla`'s own `describe` as the stored schema read
     aloud — `error_rate of the run (response_time) ≤ 0.01 — actual
     0.0223463687150838` — which review.md's copy table names verbatim as the
     pattern to replace, and which this band renders at the largest size on
     the page, directly above a gates table that has said "Whole-run error
     rate / ≤ 1% / 2.23%" since review.md 1, 3 and 15 landed. Two vocabularies
     for one fact, and the raw one was the prominent one.

     The message survives as the fallback for exactly the case the fields
     cannot describe: a `not_applicable` gate, where `describeSlaOutcome`
     answers null and the evaluator's own words say why nothing was checked. */
  const detail =
    (failed ? (describeSlaOutcome(failed) ?? failed.message) : null) ??
    decisionDetail(decision, counts);
  const runId = identity.id;
  const exportRun = () =>
    downloadRunSummary(
      `perfportal-${runId}-run.json`,
      runSummaryJson({ identity, status, verdict, assertions }),
    );

  return (
    <section
      aria-label="Release decision"
      /* ═══ A CONTAINER, NOT A VIEWPORT BREAKPOINT ═══
       *
       * This grid went three-up at `lg:` — 1024px of VIEWPORT, which is also
       * the width at which `ProjectRail` appears. So the band got its widest
       * layout at the exact moment it lost ~270px to the sidebar, and
       * measured at 1024x900 the tracks resolved to `338px 0px 336px`: the
       * middle column collapsed to ZERO and its text overflowed across the
       * action column, which began at the same x. 395px tall, and unreadable.
       *
       * `@container` makes the query about the width this band actually HAS.
       * `@4xl` (56rem) is above the ~677px it gets at 1024px with the rail, so
       * it stacks there and goes three-up only where three columns fit. */
      className="@container overflow-hidden rounded-xl border border-default bg-surface shadow-panel"
    >
      {/* `minmax(14rem,1fr)` for the explanation, never `minmax(0,1fr)`: a
          zero minimum is what let the other two tracks take the whole row and
          leave it nothing. With a real floor the grid overflows visibly —
          which is a bug you can SEE — rather than silently stacking text on
          top of text. */}
      <div className="grid grid-cols-1 gap-0 @4xl:grid-cols-[minmax(9rem,auto)_minmax(14rem,1fr)_minmax(18rem,auto)]">
        {/* THE VERDICT WORD — the redesign's signature, and NOT AN `<h2>`,
            though it is the largest text on the page. This band is SHELL
            CHROME — `RunShell` renders it above the `<Outlet/>`, so it is on
            all five tabs — and every `<h2>` on this page belongs to the tab
            CONTENT's own sections (`run-tables.spec.ts` asserts the Overview
            tab's outline is exactly Assertions / Simulation assertions /
            Statistics, and the Errors tab's is exactly Errors). Its two
            neighbours in the shell, `SlaBanner` and `LiveStatusStrip`,
            contribute no heading for the same reason; `RunHeader` owns the
            one `<h1>`. It would also be the only heading whose WORDS change
            per run. The section stays reachable through
            `aria-label="Release decision"`, like both neighbours.

            The word's colour is the decision mark's TEXT colour — the
            4.5:1-gated palette, as inline style from mark data, the same
            route `Badge` takes — and colour is never the only signal: the
            WORD differs per state, and the overline beneath names what it
            is a verdict OF. Reading order is word then overline —
            "Failed — release gate" — which is the verdict-first order the
            whole band exists to put on screen. */}
        <div className="flex min-w-0 flex-col justify-center gap-1 border-b border-divider p-4 @4xl:border-r @4xl:border-b-0 @4xl:p-5">
          {/* 36px, rising to 48px from `sm`. The first cut was 30px flat and
              read as a large label rather than as the page's verdict — this
              band is the one place the redesign spends size, and at 30px the
              `<h1>` above it (24px) was close enough to compete. It stays
              BELOW the heading in the document's semantics and above it in
              the type scale, which is the whole point of shell chrome that
              answers ship/no-ship. `break-words` because "Not evaluated" is
              two words and must wrap inside its column rather than widen it. */}
          {/* `uppercase` is the mockups' own treatment and it is safe HERE for
              the reason CLAUDE.md's corrected note gives: `text-transform`
              is a RENDERING property, so `textContent` stays "Failed" and
              nothing computed from it — this band contributes no heading and
              no accessible name — changes. */}
          <p
            data-testid="decision-word"
            className="font-display text-4xl leading-none font-semibold tracking-tight break-words uppercase sm:text-5xl"
            style={{ color: decisionColour(decision, counts) }}
          >
            {word}
          </p>
          {/* An overline, not a heading — same rule as `ProjectRail`'s
              "Projects" label, and `uppercase` is safe here for the same
              reason: nothing queries a `<p>` by accessible name. */}
          <p className="text-[0.75rem] font-medium text-muted">
            Release gate
          </p>
        </div>

        <div className="flex min-w-0 flex-col justify-center gap-2.5 border-b border-divider p-4 @4xl:border-r @4xl:border-b-0 @4xl:p-5">
          {/* ═══ THE BADGE STAYS ONLY WHERE IT IS NOT A SECOND COPY ═══
           *
           * For `passed`, `failed` and `not_evaluated` the 48px word beside it
           * says the same state in the same colour — two statements of one
           * fact, and the sample run showed the cost: "NOT EVALUATED" at 48px,
           * "○ not evaluated" beneath it, and the actual failed check in 12px
           * below both.
           *
           * `none` is the exception, and checking rather than assuming is what
           * caught it. `decisionWord` has no branch for `none`: it falls
           * through to "Pending" (or "Needs attention"), while the badge reads
           * "no verdict yet". A run that FINISHED with no verdict is not
           * pending, so those are different claims and the badge is the
           * accurate one. Dropping it there would have deleted the only true
           * statement on the row — the same `unevaluated` IS NOT `none`
           * distinction this file's own type comment opens with.
           *
           * The counts sentence is gated on `judged` rather than `evaluated`:
           * a project with no rules has nothing to count, and
           * "0 passed · 0 failed · 0 not applicable" over it is the
           * three-zeros overclaim this file already fixed one row down. */}
          {decision === 'none' && <Badge mark={DECISION.none} />}
          {judged && (
            <p className="text-[0.75rem] font-medium text-muted">
              {counts.passed} passed · {counts.failed} failed · {counts.not_applicable} not applicable
            </p>
          )}
          {/* THE TICK STRIP — one tick per SLA rule, in the order the counts
              sentence above reads them. `aria-hidden` because it repeats
              exactly what that sentence already says; it is the sentence's
              picture, not a second fact. Rendered only when `evaluated`, the
              same gate as the sentence and the counts — a strip of grey
              ticks over rules nobody has evaluated would be the three-zeros
              overclaim in bar form. `flex-wrap`, no cap: a run with two
              hundred rules wraps to more rows rather than silently showing
              fewer ticks than rules ("no silent caps"). Tick colours are the
              outcome marks' own, as data through style — the `Badge`
              pattern. */}
          {judged && (
            <div aria-hidden="true" data-testid="gate-ticks" className="flex flex-wrap items-center gap-1">
              {tickMarks(counts).map((mark, index) => (
                // 10px × 32px, squared rather than pill: this is a TEST STRIP,
                // and a strip's ticks are bars. At 4px wide and fully rounded
                // they read as dots — a row of beads that says "some things
                // happened" rather than "here is every rule, and these two
                // failed". Width is what makes an individual tick findable.
                <span
                  key={index}
                  className="h-8 w-2.5 rounded-sm"
                  style={{ backgroundColor: mark.colour }}
                />
              ))}
            </div>
          )}
          {/* ═══ WITHHELD ON A PHONE — review M02 ═══
           *
           * M02 asks the mobile band to "replace stacked repeated status prose
           * with short labeled rows". The rows are the `<dl>` directly below,
           * which C02 built — Platform gates and Simulation assertions now, Execution
           * having moved to the lifecycle strip — each
           * naming the system that answered. This paragraph is the PROSE half,
           * and on this run it reads "This run completed, but no SLA rule
           * produced a release verdict" while the row beneath says "Platform
           * gates — not configured". One fact, twice, in the screen a phone
           * reader has instead of a page.
           *
           * Measured at 375x812: 42px of the band's 424, and the band is the
           * whole first screen — the run's own totals begin at y886 and p95 at
           * y1198, so not one number was visible.
           *
           * A CLASS, NOT `useIsCompact`. The app's one JS breakpoint exists
           * because a class can only HIDE the charts while the cost is
           * MOUNTING them; nothing is mounted here that a phone would pay for,
           * and the rows carry the same facts at every width. `max-sm:hidden`
           * is the whole decision.
           *
           * NOT withheld when it is the one thing that says WHY. `failed`
           * supplies its own message — the first failing gate's — and that is
           * never a restatement of the rows: it names a rule. Only the
           * generated summary is dropped. */}
          <p
            data-testid="decision-detail"
            className={`max-w-3xl text-[0.8125rem] leading-relaxed text-muted${
              failed == null ? ' max-sm:hidden' : ''
            }`}
          >
            {detail}
          </p>

          {/* TWO OUTCOMES, NAMED. Each row says which system answered, so no
              reader has to infer that "0 failed" meant one system's rules and
              not the test's own checks. What the RUN itself did was a third
              row here, "Execution"; the lifecycle strip above now says it,
              with timings. */}
          <dl data-testid="run-outcomes" className="flex flex-col gap-1 text-[0.75rem]">
            <Outcome
              testId="outcome-gates"
              label="Platform gates"
              value={gatesText}
            />
            <Outcome
              testId="outcome-simulation"
              /* ═══ THE WORD THE SECTION THIS LINKS TO USES (review.md 22) ═══
               *
               * This row said "Simulation checks" and its link said "See the
               * failed simulation check", while `#simulation-assertions` — the
               * anchor that link targets — is headed "Simulation assertions". A
               * reader followed a link about a CHECK and landed on a section
               * about ASSERTIONS.
               *
               * N01 settled which word is right, and this is the caller it did
               * not reach: the PRD gives "Assertions table — expression,
               * expected, actual, status" to G-05, the TOOL's own feature, so
               * Gatling's assertions really are assertions. It was the
               * PLATFORM's rules that had borrowed the word, and those are
               * "Platform gates" one row up.
               *
               * WHICH IS WHY review.md 22's OWN SUGGESTION IS DECLINED. It asks
               * for "Simulation check" as the standard term; N01 examined that
               * exact rename, found the evidence pointed the other way, and
               * moved the platform's noun instead. Two reviews disagree and
               * this follows the one with the PRD behind it. */
              label="Simulation assertions"
              value={simulation.text}
              /* ═══ THE ONE ROW THAT IS BAD NEWS LOOKS LIKE BAD NEWS ═══
               *
               * All three rows were identical 12px `<dl>` entries, so the run
               * whose simulation failed read exactly like the run whose
               * simulation passed — and sat under a verdict word saying "NOT
               * EVALUATED", which is true of the platform gate and says
               * nothing about the check that failed.
               *
               * The emphasis is on the VALUE and never on the label, so the
               * row still reads "Simulation assertions: 1 failed — …" in order.
               * Colour is not the only signal: the word "failed" is in the
               * text, and the link below names the count. */
              tone={simulation.failedCount > 0 ? 'failed' : undefined}
              action={
                simulation.failedExpression === null ? null : (
                  <Link
                    to={`${runPath(identity.id)}#simulation-assertions`}
                    className="transition-ui font-medium text-accent hover:underline hover:underline-offset-2"
                  >
                    {simulation.failedCount === 1
                      ? 'See the failed simulation assertion'
                      : `See ${simulation.failedCount} failed simulation assertions`}
                  </Link>
                )
              }
            />
          </dl>
        </div>

        <div className="flex min-w-0 flex-col justify-center gap-3 bg-sunken/45 p-4 @4xl:p-5">
          {/* The counts, or nothing — never three zeros over a run whose
              rules have not been evaluated, AND never over a run that has no
              rules at all. `judged`, not `evaluated`: the review's "remove
              empty SLA count tiles", which is the same correction the counts
              sentence and the tick strip above just took. */}
          {judged && (
            <div className="flex flex-wrap gap-2">
              <DecisionCount label="Passed" value={counts.passed} mark={ASSERTION_OUTCOME.passed} />
              <DecisionCount label="Failed" value={counts.failed} mark={ASSERTION_OUTCOME.failed} />
              <DecisionCount
                label="N/A"
                value={counts.not_applicable}
                mark={ASSERTION_OUTCOME.not_applicable}
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Link to={runComparePath(runId)} className={linkButtonClasses}>
              <CompareTabIcon className="h-3.5 w-3.5" />
              {/* "Compare runs", not "Compare previous". The destination is a
                  PICKER over this run's cohort, and both demo runs landed on
                  "Nothing to compare yet" — the action named a comparison that
                  may not exist. Worse, `compareSelection`'s default can pick a
                  NEWER neighbour for the oldest run in a cohort, so the word
                  "previous" was not even reliably true when a run did have
                  one. The destination is unchanged and still discoverable;
                  only the promise is corrected. */}
              Compare runs
            </Link>
            <Button type="button" variant="secondary" onClick={exportRun}>
              <DownloadIcon className="h-3.5 w-3.5" />
              {/* NAMED AFTER WHAT IT WRITES. "Export run" promised a run
                  artifact; the file is identity, execution state, verdict and
                  the platform assertions — no statistics, no errors, no
                  simulation assertions, no chart data, no selected window. A
                  reader who attached it to a review expecting evidence sent
                  something close to empty. */}
              Export SLA summary (JSON)
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The tick strip's marks, one per rule, in the counts sentence's own order —
 * passed, failed, not applicable — so the picture and the words agree about
 * sequence as well as number.
 */
function tickMarks(counts: AssertionCounts): readonly Mark[] {
  return [
    ...Array.from({ length: counts.passed }, () => ASSERTION_OUTCOME.passed),
    ...Array.from({ length: counts.failed }, () => ASSERTION_OUTCOME.failed),
    ...Array.from({ length: counts.not_applicable }, () => ASSERTION_OUTCOME.not_applicable),
  ];
}

function DecisionCount({ label, value, mark }: { readonly label: string; readonly value: number; readonly mark: Mark }) {
  return (
    <div
      className="flex items-baseline gap-1.5 rounded-lg border border-default bg-surface px-2.5 py-1.5"
      style={{ color: mark.colour }}
    >
      <p className="text-[0.75rem] font-medium text-muted">{label}</p>
      <p className="font-mono text-base font-semibold leading-none tabular-nums text-primary">{value}</p>
    </div>
  );
}

/**
 * The word's colour, from mark DATA like every status colour in this app —
 * the text palette, gated at 4.5:1 against the card. `unevaluated` and the
 * needs-attention state borrow `STATUS.pending`'s amber: both are
 * still-in-motion states, and the run list already teaches that amber means
 * in flight.
 */
function decisionColour(decision: Decision, counts: AssertionCounts): string {
  if (decision === 'unevaluated') return STATUS.pending.colour;
  if (decision === 'none' && counts.failed > 0) return STATUS.pending.colour;
  return DECISION[decision].colour;
}

function decisionDetail(decision: Decision, counts: AssertionCounts): string {
  if (decision === 'failed') return 'One or more SLA rules failed. Start with the failed gates below.';
  if (decision === 'passed') return 'All evaluated SLA rules passed for this run.';
  if (decision === 'not_evaluated') return 'This run completed, but no SLA rule produced a release verdict.';
  if (counts.failed > 0) return 'Gate results are available, but the run verdict is still resolving.';
  if (decision === 'none') return 'This run carries no release verdict yet.';
  return 'The run has not finished evaluation yet.';
}


/**
 * The simulation's own checks, reduced to one sentence and a target.
 *
 * `undefined`/`null` is NOT `[]`. A server written before `toolAssertions`
 * existed reports nothing, and a simulation that declared no assertions
 * reports an empty list — "not reported" and "none declared" are different
 * facts, and collapsing them would invent a claim about a run nobody measured
 * that way.
 */
function summariseToolAssertions(
  toolAssertions: RunResponse['toolAssertions'],
): { text: string; failedCount: number; failedExpression: string | null } {
  if (toolAssertions === undefined || toolAssertions === null) {
    return { text: 'not reported by this run', failedCount: 0, failedExpression: null };
  }
  if (toolAssertions.length === 0) {
    return { text: 'none declared by this simulation', failedCount: 0, failedExpression: null };
  }
  const failed = toolAssertions.filter((a) => a.outcome === 'failed');
  if (failed.length === 0) {
    return {
      text: `all ${toolAssertions.length} passed`,
      failedCount: 0,
      failedExpression: null,
    };
  }
  return {
    text: `${failed.length} failed — ${failed[0]!.expression}`,
    failedCount: failed.length,
    failedExpression: failed[0]!.expression,
  };
}

/** One labelled outcome. A `<dl>` row, because each is a term and its value. */
function Outcome({
  testId,
  label,
  value,
  tone,
  action = null,
}: {
  readonly testId: string;
  readonly label: string;
  readonly value: string;
  /**
   * `'failed'` puts the status palette on the VALUE — the one row carrying bad
   * news, drawn so a scan lands on it rather than on the three zeros that used
   * to be louder than it.
   *
   * Read through `var()` rather than a `text-status-failed` utility: those
   * tokens live on `:root` and not inside `@theme`, so Tailwind generates no
   * utility for them and the class would emit nothing at all. `Badge`,
   * `StatTile` and `RunList` all take this same route.
   */
  readonly tone?: 'failed';
  readonly action?: ReactNode;
}) {
  return (
    <div data-testid={testId} className="flex flex-wrap items-baseline gap-x-2">
      <dt className="shrink-0 font-medium text-muted">{label}</dt>
      <dd
        className={`min-w-0 ${tone === 'failed' ? 'font-semibold' : 'text-primary'}`}
        style={tone === 'failed' ? { color: 'var(--color-status-failed)' } : undefined}
      >
        {value}
      </dd>
      {action}
    </div>
  );
}
