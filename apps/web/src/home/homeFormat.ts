import type { ActivityResponse, AttentionReason } from '@perfportal/contracts';
import { STATUS, VERDICT, type Mark } from '../routes/marks';

/**
 * ═══ THE HOME PAGE'S SMALL DECISIONS, IN ONE FILE ═══
 *
 * Each of these is a sentence or a choice the page makes from the activity
 * answer, kept out of the components so it can be read, and tested, without
 * rendering anything. The components own markup; this file owns what the
 * markup says.
 */

export type AttentionState = 'filled' | 'clean' | 'gap' | 'empty';

/**
 * Which of the attention card's four faces the answer calls for, in the order
 * the questions are asked: is there something to look at, did anything run,
 * has anything EVER run, and otherwise there is nothing at all.
 *
 * `gap` and `empty` are different sentences to a reader and the difference is
 * `lastRun`: a quiet week in an org with history is a coverage question
 * ("you stopped sending results"), while an org that has never run anything
 * needs a first run, not a reminder.
 */
export function attentionState(a: ActivityResponse): AttentionState {
  if (a.attention.length > 0) return 'filled';
  if (a.runCount > 0) return 'clean';
  if (a.lastRun !== null) return 'gap';
  return 'empty';
}

/**
 * The name the greeting uses: the first word of the user's name, else the
 * local part of their email. A name is free text — `"  Ada Lovelace "` is a
 * real thing somebody typed — and an email always has a local part, so the
 * heading never reads "Hello, ".
 */
export function greetingName(user: { readonly name: string; readonly email: string }): string {
  const first = user.name.trim().split(/\s+/)[0];
  if (first) return first;
  return user.email.split('@')[0] ?? user.email;
}

/**
 * Smaller than the distance any real ratio sits from a whole percent, and
 * larger than the error `rate * 100` carries. For counts below a hundred
 * million that distance is at least 1e-8 of a percent (a ratio `n / d` is a
 * multiple of `1 / d` away from a whole percent); the double-precision error
 * in the product is around 1e-14.
 */
const PERCENT_NUDGE = 1e-9;

/**
 * The pass rate as the whole percent rounded DOWN, so 199 of 200 reads 99% and
 * never 100% — a figure that says "everything passes" must mean it.
 *
 * The nudge is the part that is not obvious. `29 / 100 * 100` is
 * `28.999999999999996` in IEEE doubles, so a bare `Math.floor(rate * 100)`
 * reads 29 of 100 as 28% — and 57 and 58 of 100 the same way, sixteen ratios
 * in all with a denominator up to 400. That is a number wrong by a whole point
 * on a screen whose one job is to state it.
 */
export function passRateLabel(rate: number): string {
  return `${Math.floor(rate * 100 + PERCENT_NUDGE)}%`;
}

/**
 * What to say about one clause of the attention rule.
 *
 * The words are the ones the rest of the product already uses for the same
 * facts — "SLA failed" for a verdict, "incomplete" for a stopped stream — so a
 * reader meets one vocabulary. Only the failed-check count needs the run's
 * `checks`, and it is null for a run that recorded none; a reason that says
 * "assertion" with no number is still true, where "0 assertions failed" would
 * contradict the reason it is explaining.
 */
export function reasonLabel(
  reason: AttentionReason,
  checks: { readonly failed: number; readonly total: number } | null,
): string {
  switch (reason) {
    case 'gate_failed':
      return 'SLA failed';
    case 'failed':
      return 'Could not be ingested';
    case 'incomplete':
      return 'Incomplete';
    case 'assertion_failed':
      if (checks === null) return 'Assertion failed';
      return checks.failed === 1 ? '1 assertion failed' : `${checks.failed} assertions failed`;
  }
}

/**
 * The shape and colour a reason's badge wears, borrowed from the outcome it is
 * an instance of — and not re-invented, because `routes/marks.tsx` is the one
 * place that decides what an outcome looks like, and a failed run that was red
 * and crossed on the run list but amber here would be two answers to one
 * question. The WORDS are the reason's own: "SLA failed" is more use on this
 * page than the bare "failed" a verdict badge carries.
 *
 *   failed            a status that is `failed`             STATUS.failed
 *   incomplete        a status that is `incomplete`         STATUS.incomplete
 *   gate_failed       a verdict that is `failed`            VERDICT.failed
 *   assertion_failed  the simulation's own check failed     STATUS.failed's
 *                                                           shape and colour
 *
 * The last has no outcome of its own — a check is neither a status nor a
 * verdict — and it IS a failure, so it wears the failure's.
 */
const REASON_MARK: Record<AttentionReason, Mark> = {
  failed: STATUS.failed,
  incomplete: STATUS.incomplete,
  gate_failed: VERDICT.failed,
  assertion_failed: STATUS.failed,
};

export function reasonMark(
  reason: AttentionReason,
  checks: { readonly failed: number; readonly total: number } | null,
): Mark {
  const base = REASON_MARK[reason];
  return { glyph: base.glyph, colour: base.colour, label: reasonLabel(reason, checks) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long ago, in CALENDAR days in `tz`: `today`, `1 day ago`, `51 days ago`
 * — the count of local midnights between the run's date and today's date.
 *
 * ═══ CALENDAR DAYS, IN THE ZONE THE WINDOW WAS COUNTED IN ═══
 *
 * It used to be elapsed time, floored: a day was 24 hours. Beside the gap
 * state that contradicted the sentence above it. The attention window starts
 * at local midnight six days ago (the glance's first boundary), and a run in
 * the gap state arrived before it — so it can be 6 days 23 hours old by the
 * clock and still be a run from the day BEFORE the window, and the page read
 * "No runs in the last 7 days" beside "6 days ago". Counted by calendar day in
 * the response's own `window.tz`, the same zone its days were counted in, such
 * a run is on a date at least seven days back and always reads "7 days ago" or
 * more. The glance above it speaks in calendar days already; this is the same
 * word for the same thing.
 *
 * So a run at 23:30 yesterday is "1 day ago" at 00:10 today, forty minutes
 * later, and a run at 00:10 today is still "today" at 23:50. A clock that is a
 * minute ahead of the server reads as `today`, never as a negative count.
 *
 * Each date is read with an `Intl.DateTimeFormat` built PER CALL — one built
 * at import freezes its zone (CLAUDE.md, the time-window entry) — and the two
 * are differenced as UTC calendar days, so a daylight-saving change between
 * them cannot add or lose a day. A zone this browser's `Intl` does not know
 * (the server can echo one it accepted) is read as UTC rather than taking the
 * card down.
 */
export function daysAgo(iso: string, now: Date, tz: string): string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    format = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  /** The instant's local date in `tz`, as that date's UTC midnight. */
  const localDay = (at: Date): number => {
    const parts = format.formatToParts(at);
    const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(part('year'), part('month') - 1, part('day'));
  };
  const days = Math.max(0, Math.round((localDay(now) - localDay(new Date(iso))) / DAY_MS));
  if (days === 0) return 'today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/**
 * What to call a row of the attention table: its test's name, else the
 * simulation the run recorded (a run whose test was deleted still has one),
 * else — for a bundle that never parsed a header and so knows nothing about
 * itself — `Upload` and the start of its id, which is at least the same words
 * for the same upload every time it is seen.
 */
export function attentionRowLabel(row: ActivityResponse['attention'][number]): string {
  return row.test?.name ?? row.run.simulation ?? `Upload ${row.run.id.slice(0, 8)}`;
}
