import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentStatusResponse } from '@perfportal/contracts';
import { agentStatusQuery } from '../api/agent';
import { Payload, Undrawn, type Slot } from '../routes/payload';
import { useRunTerminal, useWindowFromShell } from '../routes/useRunWindow';
import Chart from './Chart';
import { RUN_TIME_GROUP } from './crosshair';
import { toStatusRate } from './transforms/agentRates';
import type { TimeDomainMs } from './types';

/** GE's title, verbatim (spec §2). Exported so the Report's live notice names
 *  this chart in the same words. */
export const RESPONSES_BY_STATUS: Slot = { id: 'agent-status', title: 'Responses per Second by Status' };

/**
 * Why the status chart has nothing to draw, in `AgentUnavailable`'s words for
 * each reason — one sentence per fact, because they send a reader to different
 * work: no agent ran (start the run from the on-prem runner), the file could
 * not be read (the stored reason says why), or the agent's HTTP collector was
 * off (its own reason says why). A null reason is the contract's allowance for
 * an older body, read as the first.
 */
function unavailableSentence(status: AgentStatusResponse): string {
  if (status.reason === 'unreadable') {
    return (
      "This run's agent file could not be read, so its HTTP status codes cannot be drawn. " +
      (status.detail === null ? 'No reason was stored with it.' : `The stored reason: ${status.detail}`)
    );
  }
  if (status.reason === 'http_not_collected') {
    return (
      "The agent's HTTP collector was off for this run, so it recorded no status codes." +
      (status.detail === null ? '' : ` The agent's reason: ${status.detail}`)
    );
  }
  return 'This run carries no HTTP status codes: it has no agent file.';
}

/**
 * GE's "Responses per Second by Status", in the Report's Requests section:
 * one series per status code, from the run's agent file. A `simulation.log`
 * records no status code, so this is the one Requests chart with another
 * source — and the one a run can lack while every chart beside it draws.
 *
 * ASKED FOR ONLY ONCE THE RUN IS TERMINAL. The Requests section draws a
 * withheld notice in its place while the run streams, and this read is gated
 * on `terminal` as well: an agent read answers 200 or an error and never a run
 * body at 202, and a live run's agent file does not exist yet (spec §4).
 *
 * A RUN WITHOUT ONE KEEPS THE FIGURE, SAYING WHY — never an empty chart, which
 * would read as "measured, and no responses came back" (spec §5). The figure
 * stays in GE's position, so the sequence develops no hole.
 *
 * A time chart like its neighbours: a value x-axis in milliseconds labelled as
 * clock time, on the shell's domain, sharing the run's crosshair.
 */
export default function ResponsesByStatusChart({
  runId,
  domainMs,
  warmupMs,
  windowSelected,
}: {
  readonly runId: string;
  readonly domainMs: TimeDomainMs | undefined;
  /** The run's warm-up, shaded as on its Requests neighbours: the same seconds, the same band. */
  readonly warmupMs?: number;
  /**
   * REQUIRED, as on every Requests chart: a window that selects nothing and a
   * run that recorded nothing draw the same empty payload, and the sentence
   * must name the one the reader asked about.
   */
  readonly windowSelected: boolean;
}) {
  const { terminal } = useRunTerminal(runId);
  const window = useWindowFromShell();
  const status = useQuery({ ...agentStatusQuery(runId, window), enabled: terminal });
  return (
    <Payload query={status} slots={[RESPONSES_BY_STATUS]}>
      {(data) =>
        data.available ? (
          <StatusRateChart data={data} domainMs={domainMs} warmupMs={warmupMs} windowSelected={windowSelected} />
        ) : (
          <Undrawn slot={RESPONSES_BY_STATUS} reason={unavailableSentence(data)} />
        )
      }
    </Payload>
  );
}

function StatusRateChart({
  data,
  domainMs,
  warmupMs,
  windowSelected,
}: {
  readonly data: AgentStatusResponse;
  readonly domainMs: TimeDomainMs | undefined;
  readonly warmupMs: number | undefined;
  readonly windowSelected: boolean;
}) {
  // Memoised: `Chart`'s option effect depends on `data` by identity.
  const chart = useMemo(() => toStatusRate(data, { windowSelected }), [data, windowSelected]);
  return (
    <Chart
      id={RESPONSES_BY_STATUS.id}
      title={RESPONSES_BY_STATUS.title}
      data={chart}
      kind="line"
      // No status roles: the codes are open-ended, so they take the
      // categorical palette in `codes`' order.
      group={RUN_TIME_GROUP}
      // Its x is an INSTANT, not a measurement — the tooltip title names it.
      pairValue="y"
      xAxis={{ type: 'value', tickUnit: 'ms-as-s', min: domainMs?.[0], max: domainMs?.[1], warmupMs }}
      yAxis={{ name: 'Responses/s' }}
      unit="/s"
    />
  );
}
