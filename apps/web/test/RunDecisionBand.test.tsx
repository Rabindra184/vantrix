import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { Assertion, RunResponse } from '@perfportal/contracts';
import RunDecisionBand from '../src/routes/RunDecisionBand';
import { runSummaryJson } from '../src/routes/runExport';

afterEach(cleanup);

const RUN: RunResponse = {
  id: 'a66548b7-2962-43ff-8b93-7149a6f2a1b8',
  project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
  status: 'complete',
  verdict: 'failed',
  tool: 'gatling',
  toolVersion: '3.15.1',
  simulation: 'example.ParitySimulation',
  description: null,
  durationMs: 63161,
  startedAt: '2026-08-14T10:43:49.546Z',
  toolStartedAt: '2026-08-07T05:30:02.171Z',
  assertions: [],
};

const ASSERTIONS: readonly Assertion[] = [
  {
    ruleId: '22222222-2222-4222-8222-222222222222',
    outcome: 'failed',
    actualValue: 1830,
    message: 'p99 breached its threshold.',
    rule: {
      scope: 'run',
      targetName: null,
      family: 'response_time',
      metric: 'p99',
      comparator: 'lte',
      threshold: 750,
    },
  },
];

function renderBand(
  over: Partial<{
    status: RunResponse['status'];
    verdict: RunResponse['verdict'] | undefined;
    assertions: readonly Assertion[] | undefined;
    toolAssertions: RunResponse['toolAssertions'];
  }> = {},
) {
  const props = {
    status: RUN.status,
    verdict: RUN.verdict as RunResponse['verdict'] | undefined,
    assertions: ASSERTIONS as readonly Assertion[] | undefined,
    toolAssertions: undefined as RunResponse['toolAssertions'],
    ...over,
  };
  return render(
    <MemoryRouter>
      <RunDecisionBand
        identity={RUN}
        status={props.status}
        verdict={props.verdict}
        assertions={props.assertions}
        toolAssertions={props.toolAssertions}
      />
    </MemoryRouter>,
  );
}

/** One failing and one passing simulation check, as `ParitySimulation` has. */
const TOOL: NonNullable<RunResponse['toolAssertions']> = [
  {
    expression: 'Global: max of response time is less than 10000.0',
    actualValue: 2503,
    outcome: 'passed',
  },
  {
    expression: 'Search: 95th percentile of response time is less than 100.0',
    actualValue: 1939.53,
    outcome: 'failed',
  },
];

describe('RunDecisionBand', () => {
  it('keeps compare as a real link and exposes export as a run action', () => {
    renderBand();
    expect(screen.getByRole('link', { name: 'Compare runs' })).toHaveAttribute(
      'href',
      `/runs/${RUN.id}/compare`,
    );
    expect(
      screen.getByRole('button', { name: 'Export SLA summary (JSON)' }),
    ).toBeInTheDocument();
  });

  /**
   * `undefined` IS NOT `null`, AND NEITHER IS A VERDICT.
   *
   * `RunShell`'s prop docstring: "`undefined` means NOT EVALUATED YET and
   * omits the badge; `null` means evaluated with no verdict." `RunHeader`
   * has always honoured it — `run-detail.spec.ts` pins that a live run shows
   * no verdict badge at all — and this band shipped rendering
   * `VERDICT.none` ("no verdict yet") for BOTH, putting the claim the header
   * omits one element below it.
   *
   * Both directions are asserted, because "renders no badge" alone is
   * satisfied by a band that renders no badge ever.
   */
  it('omits the verdict badge for a run nobody has finished measuring', () => {
    renderBand({ status: 'running', verdict: undefined, assertions: undefined });
    expect(screen.queryByText('no verdict yet')).toBeNull();
    // The positive half — the band still SAYS what state the gate is in,
    // so the absent badge is a decision and not a blank panel. The redesign
    // split the old sentence ("Release gate pending") into the big verdict
    // WORD and a constant overline naming its subject; both halves are
    // asserted so neither can silently vanish. Not a heading: see the
    // band's own comment on why shell chrome contributes none.
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Release gate')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  /* ════════════════════════════════════════════════════════════════════ *
   * THE RUN STATE NOTHING HAD EVER RENDERED
   * ════════════════════════════════════════════════════════════════════ */

  /**
   * ═══ THE EXECUTION ROW MOVED TO THE LIFECYCLE STRIP ═══
   *
   * This band used to say what the RUN did in a row of its own — "incomplete —
   * the stream stopped early" against "could not be processed", an exclusive
   * pair because the two send a reader to different work. The run lifecycle
   * strip above the band says it now, with timings, and
   * `RunLifecycle.test.tsx` carries both halves of that pair. What stays here
   * is that the band no longer says it at all: two places stating one fact is
   * how they come to disagree.
   */
  it('has no Execution row: the lifecycle strip above it says what the run did', () => {
    renderBand({ status: 'incomplete', verdict: null, assertions: undefined });
    expect(screen.queryByTestId('outcome-execution')).toBeNull();
    expect(screen.queryByText(/stream stopped early|could not be processed/i)).toBeNull();
  });

  it('does render the no-verdict badge for a run that WAS evaluated', () => {
    renderBand({ verdict: null, assertions: [] });
    expect(screen.getByText('no verdict yet')).toBeInTheDocument();
  });

  /**
   * Three zeros are three measurements. `RunShell` states the rule two lines
   * from its own `<RunDecisionBand>` call — `null`, not `0`, until the
   * payload has actually resolved — and the band's counts were exempt from
   * it: a pending run drew "Passed 0 / Failed 0 / N/A 0" over rules nobody
   * had evaluated.
   */
  it('draws no assertion counts at all until the run has been evaluated', () => {
    renderBand({ status: 'pending', verdict: undefined, assertions: undefined });
    for (const label of ['Passed', 'Failed', 'N/A']) {
      expect(screen.queryByText(label)).toBeNull();
    }
    // Positive half: the counts DO appear once there is something to count,
    // so the assertion above is about the gate and not about the labels.
    // 'Passed', not 'Failed': the default render's big verdict WORD is also
    // "Failed", so that string matches two elements — the label the big
    // word can never spell is the one that uniquely proves a count chip.
    cleanup();
    renderBand();
    expect(screen.getByText('Passed')).toBeInTheDocument();
  });

  /**
   * ═══ INVERTED, NOT DELETED (review 09-13 C01) ═══
   *
   * This asserted the opposite — that an evaluated run with NO rules still
   * drew "Passed 0 / Failed 0 / N/A 0" — on the reading that `[]` is a real
   * evaluation and zero is a real count.
   *
   * It is not. `gatesText` in the same component had already reached the other
   * conclusion for its own row, and says so: "an empty list means nothing
   * judged the run, which is not the same as nothing failing." The counts
   * sentence and these tiles kept the old reading, so a run with no SLA rules
   * and one FAILED simulation check stated the same non-fact four times — the
   * 48px word, the badge, the sentence, and these tiles — while the failure
   * appeared once in 12px underneath. A fast scan finds the zeros.
   *
   * The distinction that survives is the one below this: `undefined` (nobody
   * has evaluated) and `[]` (nothing to evaluate) both draw no counts, for
   * different reasons, and neither is the same as a real zero. A run WITH
   * rules still shows them — asserted directly above, which is what stops this
   * change from being "hide the counts".
   */
  it('draws no counts for an evaluated run that has no rules to count', () => {
    renderBand({ verdict: 'not_evaluated', assertions: [] });
    for (const label of ['Passed', 'Failed', 'N/A']) {
      expect(screen.queryByText(label)).toBeNull();
    }
    // And the row that CAN say something true about it still does.
    expect(screen.getByTestId('outcome-gates')).toHaveTextContent(/not configured/i);
  });

  /**
   * ═══ THE FAILURE IS THE LOUDEST THING IN THE BAND (review 09-13 C01) ═══
   *
   * The three outcome rows were identical 12px entries, so a run whose
   * simulation failed read exactly like one whose simulation passed — beneath
   * a verdict word saying "NOT EVALUATED", which is true of the platform gate
   * and says nothing about the check that failed.
   *
   * Asserted as emphasis on the VALUE and not on the label, so the row still
   * reads "Simulation checks: 1 failed — …" in order; and colour is never the
   * only signal, which is why the word "failed" has to be in the text too.
   */
  it('marks the simulation row when a check failed, and leaves the others plain', () => {
    renderBand({
      verdict: 'not_evaluated',
      assertions: [],
      toolAssertions: [
        { expression: 'Search: 95th percentile of response time is less than 100.0', actualValue: 1939.53, outcome: 'failed' },
      ],
    });

    const simulation = screen.getByTestId('outcome-simulation');
    const value = simulation.querySelector('dd')!;
    expect(value).toHaveTextContent(/1 failed/);
    expect(value.getAttribute('style') ?? '').toContain('--color-status-failed');

    // The other row is not competing for the same attention. (Execution has
    // its own row no longer — it moved to the lifecycle strip above the band;
    // see "has no Execution row" above — so only Platform gates remains here.)
    for (const id of ['outcome-gates']) {
      const other = screen.getByTestId(id).querySelector('dd')!;
      expect(other.getAttribute('style') ?? '').not.toContain('--color-status-failed');
    }
  });

  /**
   * THE TICK STRIP FOLLOWS THE COUNTS' OWN GATE. It is the counts sentence's
   * picture — one tick per rule — so it must appear exactly when the counts
   * do and never over rules nobody has evaluated (grey ticks over an
   * unevaluated run would be the three-zeros overclaim in bar form). It is
   * `aria-hidden` because the sentence beside it already carries the same
   * fact as text: a screen reader hearing the counts and then a run of
   * unnamed presentational marks would get the information twice, once
   * badly — the same argument `Badge` makes for its glyph.
   */
  it('draws one aria-hidden tick per rule once evaluated, and none before', () => {
    renderBand({ status: 'pending', verdict: undefined, assertions: undefined });
    expect(screen.queryByTestId('gate-ticks')).toBeNull();

    // A mixed cohort, not the single-failure default: three rules with three
    // different outcomes is what proves the strip counts EVERY outcome
    // rather than only the one the default fixture happens to carry.
    const mixed: readonly Assertion[] = [
      ASSERTIONS[0]!,
      {
        ...ASSERTIONS[0]!,
        ruleId: '33333333-3333-4333-8333-333333333333',
        outcome: 'passed',
        message: 'p99 within its threshold.',
      },
      {
        ...ASSERTIONS[0]!,
        ruleId: '44444444-4444-4444-8444-444444444444',
        outcome: 'not_applicable',
        message: 'Too few samples to evaluate.',
      },
    ];
    cleanup();
    renderBand({ assertions: mixed });
    const strip = screen.getByTestId('gate-ticks');
    expect(strip).toHaveAttribute('aria-hidden', 'true');
    expect(strip.childElementCount).toBe(mixed.length);
  });

  it('exports the run summary the decision band is showing', async () => {
    const held: { blob: Blob | null } = { blob: null };
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => {
        held.blob = blob;
        return 'blob:test';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', { configurable: true, value: () => {} });

    renderBand();
    fireEvent.click(screen.getByRole('button', { name: 'Export SLA summary (JSON)' }));

    if (held.blob === null) throw new Error('Export run produced no blob');
    const payload = JSON.parse(await held.blob.text()) as {
      run: { id: string; status: string; verdict: string };
      assertions: readonly { ruleId: string; outcome: string }[];
    };
    expect(payload.run).toMatchObject({ id: RUN.id, status: 'complete', verdict: 'failed' });
    expect(payload.assertions).toHaveLength(1);
    expect(payload.assertions[0]).toMatchObject({ ruleId: ASSERTIONS[0]?.ruleId, outcome: 'failed' });
  });
});

describe('runSummaryJson', () => {
  it('includes export time, run identity and assertions without inventing metrics', () => {
    const json = runSummaryJson({
      identity: RUN,
      status: RUN.status,
      verdict: RUN.verdict,
      assertions: ASSERTIONS,
      exportedAt: '2026-08-21T00:00:00.000Z',
    });

    expect(JSON.parse(json)).toMatchObject({
      exportedAt: '2026-08-21T00:00:00.000Z',
      run: { id: RUN.id, simulation: RUN.simulation, status: RUN.status, verdict: RUN.verdict },
      assertions: [{ ruleId: ASSERTIONS[0]?.ruleId, outcome: 'failed' }],
    });
  });
});

/**
 * REVIEW C02 — "NEEDS ATTENTION: 0" OVER A RUN WITH A FAILED CHECK.
 *
 * Both demo runs showed "Not evaluated" and "0 passed · 0 failed", because
 * those are PLATFORM-SLA counters and neither project had configured a rule.
 * Meanwhile `ParitySimulation` had a failed Search p95 assertion declared by
 * the simulation itself, and the assertion corpus had many — all of them far
 * below the fold, behind a 460px time selector.
 *
 * Short labels over one system's counters read as overall test health. The fix
 * was to state the facts SEPARATELY, so no single word has to carry them all —
 * originally three, execution among them; the run lifecycle strip above the
 * band now says execution, with timings (see "has no Execution row" above),
 * so the band states the remaining two.
 *
 * The release verdict deliberately does NOT absorb simulation results: a
 * platform gate is the organisation's policy and a simulation assertion is the
 * test author's, and quietly merging them would make the gate mean something
 * nobody configured. The band reports both and conflates neither.
 */
describe('RunDecisionBand — two outcomes, not one word', () => {
  it('states platform gates and simulation assertions separately', () => {
    renderBand({ verdict: 'not_evaluated', assertions: [], toolAssertions: TOOL });
    const outcomes = screen.getByTestId('run-outcomes');
    expect(outcomes).toHaveTextContent(/platform gates/i);
    // THE SAME NOUN THE SECTION THIS LINKS TO USES. The row said "Simulation
    // checks" while `#simulation-assertions` is headed "Simulation assertions",
    // so a reader followed a link about a check and landed on assertions —
    // review.md 22, and N01's own vocabulary reaching its last caller.
    expect(outcomes).toHaveTextContent(/simulation assertions/i);
    expect(outcomes).not.toHaveTextContent(/simulation checks/i);
  });

  it('says the platform gates are not configured rather than showing three zeros', () => {
    renderBand({ verdict: 'not_evaluated', assertions: [], toolAssertions: TOOL });
    expect(screen.getByTestId('outcome-gates')).toHaveTextContent(/not configured/i);
  });

  it('counts the failed simulation checks', () => {
    renderBand({ verdict: 'not_evaluated', assertions: [], toolAssertions: TOOL });
    expect(screen.getByTestId('outcome-simulation')).toHaveTextContent(/1 failed/i);
  });

  /** The acceptance: the failure is identifiable from the first screen. */
  it('links to the failing check and names it', () => {
    renderBand({ verdict: 'not_evaluated', assertions: [], toolAssertions: TOOL });
    const link = screen.getByRole('link', { name: /simulation assertion/i });
    expect(link).toHaveAttribute('href', `/runs/${RUN.id}#simulation-assertions`);
    expect(screen.getByTestId('outcome-simulation')).toHaveTextContent(/Search/);
  });

  it('says so plainly when every simulation check passed', () => {
    renderBand({
      verdict: 'not_evaluated',
      assertions: [],
      toolAssertions: [TOOL[0]!],
    });
    expect(screen.getByTestId('outcome-simulation')).toHaveTextContent(/all 1 passed|1 passed/i);
    expect(screen.queryByRole('link', { name: /simulation assertion/i })).not.toBeInTheDocument();
  });

  it('distinguishes a simulation that declared none from one that passed', () => {
    renderBand({ verdict: 'not_evaluated', assertions: [], toolAssertions: [] });
    expect(screen.getByTestId('outcome-simulation')).toHaveTextContent(/none declared/i);
  });

  /** A run from a server that predates the field must not be reported as
   *  "none declared" — absent and empty are different facts. */
  it('says the simulation checks are unknown when the field is absent', () => {
    renderBand({ verdict: 'not_evaluated', assertions: [], toolAssertions: undefined });
    expect(screen.getByTestId('outcome-simulation')).toHaveTextContent(/not reported|unknown/i);
  });

  /**
   * THE LINE THE REVIEW DREW, AND IT MATTERS MORE THAN THE REST. A failed
   * simulation check must not silently turn the RELEASE GATE red: that word
   * answers the organisation's policy, and no rule was configured here.
   */
  it('does not let a failed simulation check redefine the release verdict', () => {
    renderBand({ verdict: 'not_evaluated', assertions: [], toolAssertions: TOOL });
    /* The BAND'S OWN VERDICT WORD, not any text on the page: "Failed" is also
       a legitimate counter label beside it, and asserting on the page text
       would fail for a reason that is not this rule.

       The word is "Not configured" rather than "Not evaluated" since the copy
       table split the two (below) — the CLAIM here is unchanged and is what
       this case is about: whatever the word is, a failed simulation check may
       not make it "Failed". Pinned as a negative for exactly that reason. */
    expect(screen.getByTestId('decision-word')).not.toHaveTextContent(/failed/i);
    expect(screen.getByTestId('decision-word')).toHaveTextContent(/^not configured$/i);
  });
});

/**
 * ═══ "Not configured" IS NOT "Not evaluated" (review 09-13 copy table) ═══
 *
 * The row is "Repeated Not evaluated block" -> "`SLA: Not configured`". The
 * 48px word said `Not evaluated` for two different facts: a project with NO
 * RULE, and rules that all came back not applicable. The first is a setup
 * state a reader can act on; the second is a real evaluation with nothing to
 * say. `gatesText` has drawn that distinction since C01 and the word above it
 * contradicted it.
 *
 * Three states, because the third is the one a careless fix breaks: an ABSENT
 * assertion list is a run whose gates have not been reported yet, and calling
 * that "Not configured" is a claim about a project nobody has heard from.
 */
describe('RunDecisionBand — what the verdict word says when nothing failed', () => {
  const word = () => screen.getByTestId('decision-word');

  it('says Not configured when no rule judged the run', () => {
    renderBand({ verdict: 'not_evaluated', assertions: [], toolAssertions: [] });
    expect(word()).toHaveTextContent(/^not configured$/i);
  });

  it('still says Not evaluated when rules ran and none applied', () => {
    renderBand({
      verdict: 'not_evaluated',
      assertions: [
        {
          ruleId: '55555555-5555-4555-8555-555555555555',
          outcome: 'not_applicable',
          actualValue: null,
          message: 'The run recorded no requests for this target.',
          rule: {
            scope: 'request',
            targetName: 'Search',
            family: 'response_time',
            metric: 'p95',
            comparator: 'lte',
            threshold: 800,
          },
        },
      ],
      toolAssertions: [],
    });
    expect(word()).toHaveTextContent(/^not evaluated$/i);
  });

  it('says neither when the gates have not been reported yet', () => {
    // `undefined`, not `[]` — an API pod that predates the field, or a run
    // read before its assertions resolved. Neither word is true of it.
    renderBand({ verdict: undefined, assertions: undefined, toolAssertions: undefined });
    expect(word()).not.toHaveTextContent(/not configured/i);
  });
});

/**
 * REVIEW M13 — THE EXPORT NAME PROMISED A RUN ARTIFACT.
 *
 * `runSummaryJson` writes identity, execution state, verdict and the platform
 * assertions. It does NOT write the headline statistics, the errors, the
 * simulation assertions, any chart data, or the selected window. "Export run"
 * is a promise of a complete artifact, and somebody attaching it to a review
 * as evidence sent something close to empty.
 *
 * Naming it after its contents is the whole fix; widening the payload is a
 * separate change with its own format questions.
 */
describe('RunDecisionBand — the export says what it exports', () => {
  it('names the SLA summary rather than promising the run', () => {
    renderBand();
    expect(screen.getByRole('button', { name: /SLA summary/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Export run$/ })).not.toBeInTheDocument();
  });

  /* review.md's copy table, row 1, on the surface that renders it largest.
     This band printed `failed.message` — the string `packages/sla`'s own
     `describe` writes, which is the stored schema read aloud — directly above
     a gates table that has spoken the reader's vocabulary since review.md 1,
     3 and 15 landed. Two vocabularies for one fact on one screen, and the raw
     one was the prominent one.

     NOTHING PINNED THIS TEXT. `decision-detail` appears in no other assertion
     in this file, which is exactly how the drift survived three corrections
     to the table beneath it.

     Asserted as a PAIR, because either half alone passes against the wrong
     product: the positive alone is satisfied by a band rendering both
     strings, and the absence alone by a band rendering neither. */
  it('states a failed gate in the reader-facing vocabulary, not the stored message', () => {
    renderBand();
    const detail = screen.getByTestId('decision-detail');
    expect(detail).toHaveTextContent(
      'Whole-run p99 response time 1830 ms exceeds the 750 ms limit.',
    );
    expect(detail).not.toHaveTextContent('p99 breached its threshold.');
  });

  /* NO CASE HERE FOR THE `?? failed.message` FALLBACK, DELIBERATELY. The band
     reads only the FAILED assertion, and `AssertionSchema` documents
     `actualValue` as null for `not_applicable` alone — so a failed gate
     always has an actual and `describeSlaOutcome` always answers a sentence
     here. A case seeding failed-with-no-actual would pin defensive behaviour
     for data the evaluator cannot produce.

     Where that fallback IS reachable is the gates table, which renders a row
     per assertion including the not_applicable ones. The null answer itself
     is pinned in `packages/contracts/test/rules.test.ts`. The first draft of
     this file seeded a lone `not_applicable` assertion and asserted its
     message appeared — it cannot: with no failed assertion the band falls
     through to `decisionDetail`, and the case failed reporting "One or more
     SLA rules failed…". Same lesson as the evidence-verdict-scope branch: a
     case that cannot reach the branch it describes is not a keeper. */
});

/**
 * REVIEW M07 — THE ACTION NAMED A COMPARISON THAT MAY NOT EXIST.
 *
 * Both demo runs offered "Compare previous" and both landed on "Nothing to
 * compare yet". And `compareSelection`'s default can pick a NEWER neighbour
 * for the oldest run in a cohort, so "previous" was not reliably true even
 * when a run did have one.
 *
 * The destination is a picker over the whole cohort, so the honest name is
 * what the picker does. The link itself is unchanged — the fix is the promise.
 */
describe('RunDecisionBand — the compare action promises only what it can', () => {
  it('offers to compare runs rather than a specific previous one', () => {
    renderBand();
    const link = screen.getByRole('link', { name: 'Compare runs' });
    expect(link).toHaveAttribute('href', `/runs/${RUN.id}/compare`);
    expect(screen.queryByRole('link', { name: /previous/i })).not.toBeInTheDocument();
  });
});
