import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AI_PENDING_REQUEUE_AFTER_MS,
  type AiAnalysisContent,
  type AiAnalysisResponse,
} from '@perfportal/contracts';
import { aiAnalysisQueryKey, fetchAiAnalysis, requestAiAnalysis } from '../api/aiAnalysis';
import { ProblemError } from '../api/fetch';
import Button from '../components/Button';
import { ChevronDownIcon } from '../components/icons';
import InfoTip from '../components/InfoTip';
import SectionHeading from '../components/SectionHeading';
import { cn } from '../lib/cn';
import { formatInstant } from './format';

/** How often a pending analysis is read again while something is writing it. */
export const AI_ANALYSIS_POLL_MS = 3_000;

type Available = Extract<AiAnalysisResponse, { available: true }>;

/**
 * When a pending analysis outlives the longest a job can run, so nothing is
 * working on it any more — the same window the POST applies
 * (`AI_PENDING_REQUEUE_AFTER_MS`), so the card offers "Try again" exactly when
 * the API would queue it again rather than answer the same pending row.
 *
 * `null` for anything but a pending row, and for a pending row of UNKNOWN age:
 * `requestedAt` null, or absent from an API that predates the field. Unknown
 * is not abandoned — the row is pending, so the card keeps polling and offers
 * no retry it cannot justify. (`new Date(undefined)` is NaN, which compared
 * false both ways and once stopped the polling in silence.)
 */
function abandonedAt(analysis: Available): number | null {
  if (analysis.state !== 'pending' || analysis.requestedAt == null) return null;
  return new Date(analysis.requestedAt).getTime() + AI_PENDING_REQUEUE_AFTER_MS;
}

/**
 * ═══ ONE PLAIN SENTENCE PER WAY AN ANALYSIS FAILS ═══
 *
 * `failureReason` is the worker's own record — a code, sometimes followed by
 * `: ` and detail (`numbers_not_in_facts: 42, 1,940`). None of it is for a
 * reader: the code is vocabulary, and the detail after it is a list of figures
 * the MODEL invented, which is the one thing this card must not print as
 * though it were a measurement. So a known code maps to a sentence, matched
 * on the code alone, and anything else gets a generic one.
 */
const FAILURE_SENTENCES: ReadonlyMap<string, string> = new Map(Object.entries({
  provider_error: 'The AI provider could not be reached, or did not answer in time.',
  internal_error: 'PerfPortal could not finish writing the analysis.',
  refused: 'The model declined to analyse this run.',
  invalid_output: 'The model’s answer was not a usable analysis, so it was not kept.',
  numbers_not_in_facts: 'The analysis cited figures this run does not contain, so it was not kept.',
  // The worker's skip reasons — the run stopped qualifying between the request
  // and the job (`aiUnavailableReason`, re-checked before any provider call).
  org_disabled: 'AI run analysis was switched off for this organisation before the analysis was written.',
  not_terminal: 'The run had not finished when the analysis was due to be written.',
  no_statistics: 'This run recorded no statistics to analyse.',
  estimated: 'This run’s statistics predate exact statistics, so it was not analysed.',
  verification_mismatch: 'This run’s stored figures disagreed with its raw log, so it was not analysed.',
  not_configured: 'No AI provider was configured when the analysis was due to be written.',
}));
const UNKNOWN_FAILURE = 'The analysis could not be written.';

export function failureSentence(reason: string | null): string {
  if (reason === null) return UNKNOWN_FAILURE;
  const code = reason.split(':', 1)[0]!.trim();
  return FAILURE_SENTENCES.get(code) ?? UNKNOWN_FAILURE;
}

/** A refused request, in words: never the 409's detail, which names its reason as a code. */
function refusalText(error: unknown): string {
  if (error instanceof ProblemError) {
    if (error.code === 'AI_ANALYSIS_UNAVAILABLE') return `This run cannot be analysed now. ${error.remediation}`;
    return `${error.detail} ${error.remediation}`;
  }
  return 'The request could not be sent. Try again in a moment.';
}

/**
 * ═══ THE AI RUN ANALYSIS CARD (GE's, on PerfPortal's exact figures) ═══
 * (docs/superpowers/specs/2026-11-02-ai-run-analysis-design.md)
 *
 * On the Summary of a FINISHED run, after the totals and the two assertion
 * bars and before the charts. Text only, so it is drawn on a phone too — it
 * is never behind `DesktopOnly` (Ruling 2).
 *
 * RENDERS NOTHING when the API says the run cannot be analysed, while the read
 * is in flight, and when it fails: the card is an optional reading of figures
 * the page already shows, and an older API (no such route) answers 404 for a
 * whole rolling deploy. A viewer on a run nobody has asked about sees nothing
 * either — there is no analysis and nothing they may do about it.
 *
 * NOT EDITABLE, AND ASKED FOR AGAIN ONLY WHERE THAT CHANGES SOMETHING: a
 * failed attempt, a stale analysis, or a pending one nothing is working on any
 * more. A ready, current analysis offers no regenerate — it would answer the
 * same text, at the operator's expense.
 *
 * `canAnalyze` IS REQUIRED: it is `run:analyze` from the shell's project
 * access, and a default would draw a button a viewer then meets as a 403.
 *
 * ═══ THE READER KEEPS THEIR PLACE, AND HEARS WHAT HAPPENED ═══
 *
 * "Analyze with AI", "Try again" and "Generate again" unmount in the commit
 * that writes the POST's pending answer, so a successful POST moves focus to
 * the card's heading (`tabIndex={-1}`) rather than letting it fall to
 * `<body>`. And ONE `role="status"` region is mounted for as long as the card
 * renders — never one mounted already holding its text, which a screen reader
 * does not announce: it reads "Analysing this run…" while pending (visible,
 * as the card's pending line) and "Analysis ready." once a pending analysis
 * the reader was waiting on turns ready (screen-reader only), and is empty
 * otherwise. One region per PAGE, not per card in a list: this card is drawn
 * once, on a run's Summary, and a component repeated N times must not add N
 * permanent live regions.
 */
export default function AiAnalysisCard({
  runId,
  canAnalyze,
}: {
  readonly runId: string;
  readonly canAnalyze: boolean;
}) {
  const queryClient = useQueryClient();
  const cardRef = useRef<HTMLElement>(null);
  const query = useQuery({
    queryKey: aiAnalysisQueryKey(runId),
    queryFn: () => fetchAiAnalysis(runId),
    // Poll only while something can still change on its own: a pending row a
    // job may be writing, including one whose age the API did not report. A
    // ready or failed one waits for the reader, and an abandoned pending one
    // waits for "Try again".
    refetchInterval: (q) => {
      const data = q.state.data;
      if (data?.available !== true || data.state !== 'pending') return false;
      // Pending: poll, unless its age is KNOWN to be past the window.
      const until = abandonedAt(data);
      return until === null || Date.now() < until ? AI_ANALYSIS_POLL_MS : false;
    },
  });
  const generate = useMutation({
    mutationFn: () => requestAiAnalysis(runId),
    // The POST answers the row as it now stands; writing it into the read's
    // key is what starts the polling, with no second request. The button that
    // asked is about to unmount with the state it belonged to, so focus goes
    // to the heading, which every state draws.
    onSuccess: (answer) => {
      queryClient.setQueryData(aiAnalysisQueryKey(runId), answer);
      cardRef.current?.querySelector<HTMLElement>('#ai-analysis-heading')?.focus();
    },
  });

  // "Analysis ready." is said once, for the transition the reader waited
  // through — pending to ready — and cleared by any other change. Adjusted
  // during render (React's pattern for state derived from a changing value),
  // so the region's text and the card's state change in the same commit.
  const state = query.data?.available === true ? query.data.state : null;
  const [seenState, setSeenState] = useState(state);
  const [readyAnnounced, setReadyAnnounced] = useState(false);
  if (state !== seenState) {
    setReadyAnnounced(seenState === 'pending' && state === 'ready');
    setSeenState(state);
  }

  // A pending row crosses its window without any read changing, so the card
  // has to be told when: one timer, set for the moment it is abandoned.
  const data = query.data;
  const until = data?.available === true ? abandonedAt(data) : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return undefined;
    const wait = until - Date.now();
    if (wait <= 0) {
      setNow(Date.now());
      return undefined;
    }
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [until]);

  if (data === undefined || data.available !== true) return null;
  if (data.state === 'none' && !canAnalyze) return null;

  const abandoned = until !== null && now >= until;
  const ask = (label: string): ReactNode =>
    canAnalyze ? (
      <Button size="sm" loading={generate.isPending} onClick={() => generate.mutate()}>
        {label}
      </Button>
    ) : null;

  return (
    <section
      ref={cardRef}
      aria-labelledby="ai-analysis-heading"
      data-testid="ai-analysis"
      className="@container flex flex-col gap-4 rounded-xl border border-default bg-surface p-4 shadow-panel"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <SectionHeading id="ai-analysis-heading" focusTarget>
          AI run analysis
        </SectionHeading>
        {data.state === 'ready' && data.generatedAt !== null && (
          <div className="flex items-center gap-1 text-[0.8125rem] text-muted">
            <span>Generated on {formatInstant(data.generatedAt)}</span>
            <InfoTip label="About this analysis">
              {`Written by ${data.model ?? 'an AI model'}. Every number in the text was checked to be one of this run’s own figures before it was kept; what it makes of them is the model’s reading, not a measurement.`}
            </InfoTip>
          </div>
        )}
      </div>

      {/* The card's one live region (see the docstring): mounted with the
          card, so a change of its text is announced. Visible while pending,
          as the pending line; screen-reader only otherwise, and `sr-only` is
          absolutely positioned, so an empty region takes no space or gap. */}
      <p
        role="status"
        data-testid="ai-analysis-status"
        className={data.state === 'pending' ? 'text-[0.8125rem] text-muted' : 'sr-only'}
      >
        {data.state === 'pending' ? 'Analysing this run…' : readyAnnounced ? 'Analysis ready.' : ''}
      </p>

      {data.state === 'none' && <div>{ask('Analyze with AI')}</div>}

      {data.state === 'pending' && abandoned && <div>{ask('Try again')}</div>}

      {data.state === 'failed' && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[0.8125rem] text-primary">{failureSentence(data.failureReason)}</p>
          {ask('Try again')}
        </div>
      )}

      {data.state === 'ready' && data.content !== null && (
        <>
          {data.stale && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-[0.8125rem] text-muted">
                This run’s figures changed after this analysis was written.
              </p>
              {ask('Generate again')}
            </div>
          )}
          <AnalysisBody content={data.content} />
        </>
      )}

      {generate.isError && (
        <p role="alert" className="text-[0.8125rem] text-primary">
          {refusalText(generate.error)}
        </p>
      )}
    </section>
  );
}

function AnalysisBody({ content }: { readonly content: AiAnalysisContent }) {
  const { insights } = content;
  const lists: readonly (readonly [string, readonly string[]])[] = [
    ['Errors', insights.errors],
    ['Assertions', insights.assertions],
    ['Injection profile', insights.injectionProfile],
    ['Response times', insights.responseTimes],
  ];
  return (
    <div className="flex flex-col gap-2">
      <AnalysisSection title="Health">
        <Headline>{content.health.headline}</Headline>
        <Bullets items={content.health.bullets} />
      </AnalysisSection>
      <AnalysisSection title="Insights">
        <Headline>{insights.headline}</Headline>
        {/* A list the model left empty is how it says there is nothing to
            report there; a heading over nothing would say the opposite. */}
        <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
          {lists
            .filter(([, items]) => items.length > 0)
            .map(([title, items]) => (
              <div key={title} className="flex flex-col gap-1">
                <h4 className="text-[0.8125rem] font-semibold text-primary">{title}</h4>
                <Bullets items={items} />
              </div>
            ))}
        </div>
      </AnalysisSection>
      <AnalysisSection title="Recommendations">
        <Headline>{content.recommendations.headline}</Headline>
        <Bullets items={content.recommendations.bullets} />
      </AnalysisSection>
    </div>
  );
}

/**
 * One of the analysis's three sections: an `<h3>` HOLDING the toggle, the
 * disclosure shape `CollapsibleSection` uses — the outline lists the section
 * and the button's name is exactly its title. Not `CollapsibleSection` itself:
 * that draws a bordered card at the `<h2>` rung, and three cards inside this
 * one would be panels nested in a panel. Open on arrival, and each opens and
 * closes on its own; a closed one renders nothing into its region.
 *
 * A `<div>`, not a `<section aria-labelledby>`: a named section is a REGION
 * landmark, and three more inside the card's own would put four landmarks on
 * one card for a reader navigating by landmark. The `<h3>` keeps each in the
 * heading outline, which is how these are found.
 */
function AnalysisSection({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const regionId = useId();
  return (
    <div className="border-t border-default pt-2">
      <SectionHeading level={3}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen((was) => !was)}
          className="flex w-full items-center gap-2 text-left"
        >
          {title}
          <ChevronDownIcon className={cn('h-4 w-4 text-muted transition-transform', open && 'rotate-180')} />
        </button>
      </SectionHeading>
      <div id={regionId} hidden={!open} className="flex flex-col gap-3 pt-2">
        {open && children}
      </div>
    </div>
  );
}

function Headline({ children }: { readonly children: ReactNode }) {
  return <p className="text-sm text-primary">{children}</p>;
}

function Bullets({ items }: { readonly items: readonly string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-[0.8125rem] text-primary">
      {items.map((item, i) => (
        // Bullets may repeat word for word; the position is what tells them apart.
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
