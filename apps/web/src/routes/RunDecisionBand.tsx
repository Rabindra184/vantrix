import type { ReactNode } from 'react';
import { describeSlaOutcome } from '@perfportal/contracts';
import type { Assertion, RunIdentity, RunResponse } from '@perfportal/contracts';
import { Link, useLocation } from 'react-router-dom';
import Badge from '../components/Badge';
import { CompareTabIcon, DownloadIcon } from '../components/icons';
import Button, { linkButtonClasses } from '../components/Button';
import { STATUS, VERDICT, type Mark } from './marks';
import { countAssertions, firstFailedAssertion, type AssertionCounts } from './assertions';
import { decisionOf, releaseWord, rulesRan, type Decision } from './decision';
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
   * gates row says "not reported yet" while it is undefined, for the same
   * reason `RunShell` passes `null` rather than `0` for an error count that
   * has not arrived: an empty list is a measurement, and nobody took it.
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
  /* THE CURRENT SEARCH TRAVELS WITH THE ASSERTIONS LINK. It is a move within
     this page (`#simulation-assertions`), and a `to` built from the bare path
     replaced the query string with nothing: a reader who had landed on
     `?request=Place%20Order#errors` and followed this link got the errors
     table's filter reset to every request, and a `from`/`to` they carried was
     gone from the tab links. The hash is the only thing this link means to
     change. */
  const { search } = useLocation();
  /**
   * ═══ AN EMPTY LIST IS NOT A ROW OF ZEROS (review 09-13 C01) ═══
   *
   * `evaluated` is `assertions !== undefined`, so an EMPTY array counts as
   * evaluated — and nothing judging a run is not the same as nothing failing.
   * For a run with no SLA rules and one failed simulation check the band once
   * said the same non-fact four times — the 48px word, a badge beside it, "0
   * passed · 0 failed · 0 not applicable" and "Passed 0 Failed 0 N/A 0" —
   * while the failure appeared once, in 12px, below all of it.
   *
   * The band draws no counts at all now (clean UI, PR 2); they live once, in
   * the gate cards below. `counts` feeds only the gates row: its "and N more"
   * and its choice between "passed" and "not evaluated".
   */
  const counts = countAssertions(assertions ?? []);
  const simulation = summariseToolAssertions(toolAssertions);
  /* `evaluated` treats `[]` as evaluated, which is what produced "0 passed ·
     0 failed" over a project with no rules at all — three zeros that read as
     health. For THIS row the distinction is the whole point: an empty list
     means nothing judged the run, which is not the same as nothing failing.

     AND AN EMPTY LIST IS "NOT CONFIGURED" ONLY IF THE RULES RAN. An incomplete
     run nothing processed carries `[]` because no rule ever ran against it
     (`rulesRan`, `decision.ts`), and "not configured" was a false claim about
     its project; "not reported yet" would be false too, since it never will
     be. It gets its own words. */
  const ran = rulesRan(status, identity.durationMs);
  const failed = firstFailedAssertion(assertions ?? []);
  const gatesText = gatesOutcome(assertions, ran, counts, failed);
  const decision: Decision = decisionOf(verdict);
  /* ═══ "Not configured" IS NOT "Not evaluated" (review 09-13 copy table) ═══
   *
   * The row is "Repeated Not evaluated block" -> "`SLA: Not configured`". The
   * 48px word read `Not evaluated` for two different facts: nothing judged
   * this run because the project has NO RULE, and rules existed and every one
   * came back not applicable. The first is a setup state the reader can act
   * on; the second is a real evaluation with nothing to say.
   *
   * The gates row has drawn that distinction since C01 — `gatesOutcome`
   * says "not configured" for no rule — and the word above it
   * contradicted it. This is the same "grep for the siblings of a comment that
   * argues a distinction" lesson CLAUDE.md already records for this component,
   * met a third time.
   *
   * KEYED ON THE ARRAY, NOT ON "is there anything to count". That is false
   * for BOTH an empty list and an absent one, and an absent one is a run whose assertions have
   * not been reported yet — "Not configured" would be a claim about a project
   * we have not heard from. */
  // The expression this comment argues lives in `releaseWord` (`decision.ts`)
  // now, so the lifecycle strip's Verdict step reads the same word by calling
  // the same function, rather than by agreeing with a copy of it.
  const word = releaseWord(verdict, assertions, ran);
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
            CHROME — `RunShell` renders it above the `<Outlet/>`, ahead of the
            Summary's own content — and every `<h2>` on this page belongs to a
            section's own content: the Summary's outline is an exact list
            (Platform gates, Simulation assertions, Over time, Errors), and a
            verdict heading would be a fifth rung in it. Its two neighbours in
            the shell, `SlaBanner` and `LiveStatusStrip`, contribute no heading
            for the same reason; `RunHeader` owns the one `<h1>`. It would also
            be the only heading whose WORDS change per run. The section stays
            reachable through `aria-label="Release decision"`, like both
            neighbours.

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
           * distinction this file's own type comment opens with. */}
          {decision === 'none' && <Badge mark={DECISION.none} />}

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
              tone={counts.failed > 0 ? 'failed' : undefined}
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
                    to={{ pathname: runPath(identity.id), search, hash: '#simulation-assertions' }}
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



/**
 * What the platform gates concluded, in the fewest words that are true — the
 * band's gates row (clean UI, PR 2). A failure is the failing gate's own
 * sentence, and "and N more" when there were others, because that sentence is
 * the one fact a reader of this band needs; the counts live once, in the gate
 * cards below. "not configured" (no rule) and "not evaluated" (rules ran and
 * judged nothing, or the run left nothing to judge) stay distinct: the first
 * is a fact about the project, the second about this run.
 */
function gatesOutcome(
  assertions: readonly Assertion[] | undefined,
  ran: boolean,
  counts: AssertionCounts,
  failed: Assertion | undefined,
): string {
  if (assertions === undefined) return 'not reported yet';
  if (!ran) return 'not evaluated';
  if (assertions.length === 0) return 'not configured';
  if (failed !== undefined) {
    const sentence = describeSlaOutcome(failed) ?? failed.message;
    if (counts.failed <= 1) return sentence;
    // One sentence, not a sentence and a fragment: the gate's own ends in a
    // full stop, so the count joins it before that stop.
    return `${sentence.replace(/\.$/, '')}, and ${counts.failed - 1} more.`;
  }
  if (counts.passed === 0) return 'not evaluated';
  return 'passed';
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
    return { text: 'not reported', failedCount: 0, failedExpression: null };
  }
  if (toolAssertions.length === 0) {
    return { text: 'none declared', failedCount: 0, failedExpression: null };
  }
  const failed = toolAssertions.filter((a) => a.outcome === 'failed');
  if (failed.length === 0) {
    return { text: 'passed', failedCount: 0, failedExpression: null };
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
