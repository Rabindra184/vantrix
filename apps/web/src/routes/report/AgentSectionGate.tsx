import { useState, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { AgentSummaryResponse, AgentUnavailableReason, Window } from '@perfportal/contracts';
import { agentSummaryQuery } from '../../api/agent';
import type { TimeDomainMs } from '../../charts/types';
import { ErrorState, LoadingState } from '../../components/States';
import useIsCompact from '../../useIsCompact';
import DesktopOnly from '../DesktopOnly';
import LiveNotice from '../LiveNotice';
import { explain, type Slot } from '../payload';
import { useRunTerminal, useTimeDomainFromShell, useWindowFromShell } from '../useRunWindow';
import { formatOffset } from '../format';
import AgentUnavailable from './AgentUnavailable';
import { REPORT_GRID } from './grid';

/** Everything an agent section reads before it can ask for its own figures. */
export interface AgentSection {
  readonly terminal: boolean;
  readonly window: Window | null;
  readonly domainMs: TimeDomainMs | undefined;
  readonly summaryQuery: UseQueryResult<AgentSummaryResponse>;
  readonly summary: AgentSummaryResponse | undefined;
  readonly needsHttp: boolean;
  /** When the run's tool started, as epoch ms — what the agent's own instants are offsets from; null until known. */
  readonly toolStartedAtMs: number | null;
  readonly compact: boolean;
  readonly shown: boolean;
  readonly show: () => void;
  /**
   * The section's figure query options, gated: `enabled` only once the run is
   * terminal, the summary says the figures exist, and they are being drawn
   * here — not withheld behind a phone's notice — and never past an `enabled`
   * the options already carry. Every section's figure read goes through this,
   * so none can forget the gate: `useQuery(section.figureQuery(agentDnsQuery(…)))`.
   */
  readonly figureQuery: <O extends object>(options: O & { readonly enabled?: boolean }) => O & { readonly enabled: boolean };
}

/**
 * The hooks every agent section of the Report runs first — Connections, DNS
 * and Load generators — and the gate (`AgentSectionGate`) that turns them into
 * whatever the section must say before it can draw.
 *
 * A HOOK AND A COMPONENT, NOT ONE COMPONENT, because the section's own hooks
 * come between them: the filter (`useReportFilter`) is checked against the
 * summary this reads, and the figure query is gated through `figureQuery`. Both
 * have to run on every render, above the gate's early returns, so a run
 * finishing or a phone reader pressing the button changes no hook order. The
 * gate itself holds no hooks, so it may return early freely.
 *
 * `needsHttp` is the API's own split (`unavailable(summary, needsHttp)` in
 * `agent.controller.ts`): connections and DNS come from the agent's HTTP
 * collector, so a run whose collector was off has none — read from the
 * summary's header, so no figure read is made for it. The load generator's
 * JVM and machine figures need no HTTP collector, and still draw.
 */
export function useAgentSection(runId: string, { needsHttp }: { readonly needsHttp: boolean }): AgentSection {
  const { terminal, detail } = useRunTerminal(runId);
  const window = useWindowFromShell();
  const domainMs = useTimeDomainFromShell();
  const compact = useIsCompact();
  const [shown, setShown] = useState(false);
  // Every agent read answers 200 or an error, never a run body at 202, and a
  // live run's figures do not exist yet — `RunTelemetry`'s `enabled: … &&
  // terminal` rule. Read on a phone too: one small body, and without it a
  // phone could not tell "no agent file" (telemetry's own phone gate takes
  // over) from a collected run (this gate's), and would gate twice.
  const summaryQuery = useQuery({ ...agentSummaryQuery(runId), enabled: terminal });
  const summary = summaryQuery.data;
  const collected = summary?.available === true && (!needsHttp || summary.header?.collects.http !== false);
  const fetchFigures = terminal && collected && (!compact || shown);
  const toolStartedAt = detail.data?.state === 'ready' ? detail.data.run.toolStartedAt : undefined;
  const toolStartedAtMs = toolStartedAt == null ? null : Date.parse(toolStartedAt);
  return {
    terminal,
    window,
    domainMs,
    summaryQuery,
    summary,
    needsHttp,
    toolStartedAtMs: toolStartedAtMs !== null && Number.isFinite(toolStartedAtMs) ? toolStartedAtMs : null,
    compact,
    shown,
    show: () => setShown(true),
    figureQuery: (options) => ({ ...options, enabled: fetchFigures && (options.enabled ?? true) }),
  };
}

/**
 * What an agent section says before it draws, in order — the one place those
 * states are decided, so the three sections cannot drift into saying them
 * three different ways:
 *
 * 1. NOT TERMINAL: a withheld notice per chart, titled as the chart is, and no
 *    request. Ahead of the phone gate, as `RunTelemetry`'s is: these sentences
 *    are not charts.
 * 2. THE SUMMARY decides the rest, so until it answers there is ONE neutral
 *    loading state — not the section's titled figures, which for a run with no
 *    agent file (every upload and plugin run) would be replaced a moment later,
 *    promising charts that never come — and one `ErrorState` if it fails.
 *    Both name the section's `subject`: the three sections share one summary,
 *    so open together they load and fail together, and three identical lines
 *    on one page would not say which section each belongs to.
 * 3. NO AGENT FILE (`not_collected`, or a null reason the contract allows) is
 *    the section's `noAgentFile` when it has one — Connections and Load
 *    generators keep the load-generator telemetry, which may still exist (spec
 *    §7.5) — and `AgentUnavailable`'s own sentence when it has none (DNS: the
 *    Go agent records no lookups).
 * 4. ANY OTHER UNAVAILABLE ANSWER is said, never replaced: an `unreadable` file
 *    was there, and showing telemetry instead would misstate the run. An HTTP
 *    collector that was off counts only for a section that `needsHttp`.
 * 5. A PHONE is offered the charts (§22.6) and fetches nothing until asked.
 * 6. THE FIGURE READ'S OWN unavailable answer is honoured too (`figures`).
 *
 * Then `children(summary)` draws — under `AgentFileNotice` when the file itself
 * says it is incomplete.
 */
export default function AgentSectionGate({
  section,
  slots,
  what,
  action,
  subject,
  noAgentFile,
  figures,
  children,
}: {
  readonly section: AgentSection;
  /** The section's charts, for the withheld notices' titles. */
  readonly slots: readonly Slot[];
  /** The phone notice's heading ("Nine connection charts of this run"). */
  readonly what: string;
  /** The phone notice's button, named after the section's charts. */
  readonly action: string;
  /** What the section would have shown ("connection figures"): named in its loading and failure lines, and by `AgentUnavailable`. */
  readonly subject: string;
  /** What a run with no agent file draws instead; absent, the not-collected notice. */
  readonly noAgentFile?: ReactNode;
  /** The figure read's answer, once it has one. */
  readonly figures: { readonly available: boolean; readonly reason: AgentUnavailableReason | null; readonly detail: string | null } | undefined;
  /** Called inside the gate's render: render components here, and never call a hook in the arrow itself. */
  readonly children: (summary: AgentSummaryResponse) => ReactNode;
}) {
  const { terminal, summary, summaryQuery } = section;

  if (!terminal) {
    return (
      <div className={REPORT_GRID}>
        {slots.map((slot) => (
          <LiveNotice key={slot.id} kind="withheld" subject={slot.title} />
        ))}
      </div>
    );
  }

  if (summary === undefined) {
    return summaryQuery.isError ? (
      <ErrorState title={`This run's ${subject} could not be loaded`} detail={explain(summaryQuery.error, 'section')} />
    ) : (
      <LoadingState label={`Loading this run's ${subject}…`} />
    );
  }

  const unavailable = (reason: AgentUnavailableReason | null, detail: string | null) => (
    <AgentSectionUnavailable reason={reason} detail={detail} subject={subject} noAgentFile={noAgentFile} />
  );

  if (!summary.available) return unavailable(summary.reason, summary.detail);
  if (section.needsHttp && summary.header?.collects.http === false) {
    return unavailable('http_not_collected', summary.header.reasons.http ?? null);
  }

  if (section.compact && !section.shown) {
    return (
      <DesktopOnly compact what={what} action={action} onShow={section.show}>
        {() => null}
      </DesktopOnly>
    );
  }

  if (figures !== undefined && !figures.available) return unavailable(figures.reason, figures.detail);

  const facts = agentFileFacts(summary, section.toolStartedAtMs);
  if (facts.length === 0) return <>{children(summary)}</>;
  return (
    <div className="flex flex-col gap-4">
      <AgentFileNotice facts={facts} />
      {children(summary)}
    </div>
  );
}

/**
 * The sentences a collected agent file's own summary carries about itself, one
 * per fact that is present — the three things `/agent` reports and no chart can
 * show:
 *
 *   capped          the file hit the agent's size cap, so everything after is gone
 *   agentError      the agent's one `error` line: it stopped collecting there
 *   malformedLines  lines the decoder could not read and skipped
 *
 * Each is a reason a chart below may be short or quiet without the run having
 * been, which is why it sits ABOVE them. The error's instant is an offset into
 * the run only when the run's tool start is known; otherwise "part-way
 * through", never a guessed time.
 */
export function agentFileFacts(summary: AgentSummaryResponse, toolStartedAtMs: number | null): readonly string[] {
  const facts: string[] = [];
  if (summary.capped) {
    facts.push('The agent file reached its size cap, so events after that point are missing.');
  }
  if (summary.agentError !== null) {
    const offset = toolStartedAtMs === null ? null : summary.agentError.at - toolStartedAtMs;
    const when = offset !== null && offset >= 0 ? `${formatOffset(offset)} into the run` : 'part-way through';
    // The agent's own message, as given — which may already end its sentence
    // ("disk full." would otherwise read "disk full.."). `machineOffSentence`'s rule.
    const message = summary.agentError.message.trim();
    facts.push(`The agent stopped collecting ${when}: ${message}${/[.!?]$/.test(message) ? '' : '.'}`);
  }
  if (summary.malformedLines > 0) {
    const lines = summary.malformedLines === 1 ? '1 line' : `${summary.malformedLines} lines`;
    facts.push(`${lines} of the agent file could not be read and ${summary.malformedLines === 1 ? 'was' : 'were'} skipped.`);
  }
  return facts;
}

/**
 * `agentFileFacts`, as one short notice. NOT a live region: it is a fact about
 * a finished run, present from the moment the section draws, and announcing it
 * three times (one per agent section) would interrupt a reader for nothing.
 */
function AgentFileNotice({ facts }: { readonly facts: readonly string[] }) {
  return (
    <div data-testid="agent-file-notice" className="rounded border border-default bg-sunken px-3 py-2 text-sm text-primary">
      {facts.map((fact) => (
        <p key={fact}>{fact}</p>
      ))}
    </div>
  );
}

/** Why a section has no agent figures: see `AgentSectionGate`'s points 3 and 4. */
function AgentSectionUnavailable({
  reason,
  detail,
  subject,
  noAgentFile,
}: {
  readonly reason: AgentUnavailableReason | null;
  readonly detail: string | null;
  readonly subject: string;
  readonly noAgentFile: ReactNode | undefined;
}) {
  if ((reason === null || reason === 'not_collected') && noAgentFile !== undefined) return <>{noAgentFile}</>;
  return <AgentUnavailable reason={reason ?? 'not_collected'} detail={detail} subject={subject} />;
}
