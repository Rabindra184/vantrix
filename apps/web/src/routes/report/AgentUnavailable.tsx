import type { AgentUnavailableReason } from '@perfportal/contracts';
import { EmptyState } from '../../components/States';

/**
 * Why a Report section has no agent figures, in the response's own words — one
 * `EmptyState` for the whole section, never a set of empty charts, which would
 * read as "measured, and found idle" (spec §5).
 *
 * The three reasons are three different facts, so three different sentences:
 *
 *   not_collected       no agent ran for this run. Connections and Load
 *                       generators never reach this — they fall back to the
 *                       load-generator telemetry, which may still exist — so
 *                       its caller is DNS, which has no telemetry equivalent.
 *   unreadable          there WAS an agent file and it could not be read. The
 *                       stored reason is shown, and no section falls back to
 *                       telemetry here: hiding the file would misstate the run.
 *   http_not_collected  the agent ran with its HTTP collector off; `detail` is
 *                       the agent's own reason.
 *
 * `subject` is what the section would have shown ("connection figures"),
 * because a reader comparing two collapsed sections needs to tell them apart.
 */
export default function AgentUnavailable({
  reason,
  detail,
  subject,
}: {
  readonly reason: AgentUnavailableReason;
  readonly detail: string | null;
  readonly subject: string;
}) {
  if (reason === 'unreadable') {
    return (
      <EmptyState
        title="This run's agent file could not be read"
        body={detail === null ? 'No reason was stored with it.' : `The stored reason: ${detail}`}
      />
    );
  }
  if (reason === 'http_not_collected') {
    return (
      <EmptyState
        title="The agent did not collect HTTP figures"
        body={
          `The ${subject} come from the agent's HTTP collector, which was off for this run.` +
          (detail === null ? '' : ` The agent's reason: ${detail}`)
        }
      />
    );
  }
  return (
    <EmptyState
      title="No agent data for this run"
      body={`The on-prem runner's Gatling agent collects ${subject} for runs it starts; this run carries no agent file.`}
    />
  );
}
