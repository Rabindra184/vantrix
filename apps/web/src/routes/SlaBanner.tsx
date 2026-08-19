import type { LiveDelta } from '@perfportal/contracts';
import { ASSERTION_OUTCOME } from './marks';
import { formatOffset } from './format';

/**
 * Which SLA rules a streaming run is breaching, right now — the banner
 * Task 6's fold owner exists to feed. Fed straight from a delta's own
 * `sla` field; nothing here re-derives or re-evaluates anything.
 *
 * ═══ A CONDITION, NOT AN EVENT ═══
 *
 * This is a banner, never a toast. A toast fires once, on arrival, and two
 * routine things then make it lie: a reader who opens the run mid-breach
 * never sees it at all, and a reconnect (`useLiveRun`'s own backoff, which
 * fires routinely) would fire it again for a breach that never stopped. So
 * this component keeps no memory of what it has already shown — no
 * dismissal, no "have I rendered this ruleId before" state — and renders
 * straight from `sla.breaching` on every call. That is what makes it survive
 * a re-render carrying the IDENTICAL data (`SlaBanner.test.tsx`'s own guard)
 * as faithfully as it disappears the instant `breaching` empties: both are
 * the same one rule, "render exactly what `breaching` says, every time",
 * applied to two different inputs rather than two different code paths.
 *
 * `role="status"`, matching every one of `LiveNotice`'s three banners: a
 * breach is a fact about the run, not an application error, and `alert`
 * would cut a screen reader off mid-sentence to announce a condition that
 * was already true before this render started.
 *
 * NO `<svg>`. This banner sits above the chart grid in `Live`
 * (`RunDetail.tsx`), outside every chart's own `<figure>` — but
 * `run-charts.spec.ts` and `request-detail.spec.ts` prove a chart drew by
 * counting `<svg>` elements INSIDE its `<figure>`, and a decorative icon
 * here would be one accidental DOM move away from corrupting that count.
 * `LiveNotice` made the identical call for the identical reason.
 *
 * NO `uppercase`, and nothing in this file is styled with one — Playwright
 * computes an accessible name after applying `text-transform`; jsdom does
 * not.
 *
 * Colour: the same `--color-status-failed` token `ASSERTION_OUTCOME.failed`
 * already carries for a failed assertion row, reached here as DATA through
 * an inline `style` rather than a class — this file reads
 * `ASSERTION_OUTCOME.failed.colour`, a JS value, never the literal token
 * name. That is a DIFFERENT route from `Login.tsx`'s own sign-in error,
 * which reaches the identical token by writing the Tailwind arbitrary-value
 * form directly in its `className` string — the token's `var(…)` reference
 * wrapped in a square-bracketed, `color:`-hinted utility — and is exactly
 * why `Login.tsx` needs its own entry in `test/tokens.test.ts`'s
 * `EXEMPT_PATHS`. This file needs no such entry: that gate's regex scans for
 * a token reference wrapped in square brackets, and nothing in this file's
 * source text is spelled that way (this docstring included — see
 * `tokens.test.ts`'s own docstring on why it describes the shape rather
 * than quoting it). `tint` (`styles/tokens.css`) turns the one colour into
 * the wash and the border, so there is no second failed-red hard-coded here
 * either way.
 *
 * ═══ THE DENOMINATOR SAYS WHAT IT COUNTS ═══
 *
 * `evaluated` is `passed + failed` -- an honest number under a misleading
 * sentence, when the sentence called it "SLA rules". A project with seven
 * rules whose percentile rules are still below the live evidence floor read
 * "1 of 1 SLA rules currently breaching" at second 30 and "1 of 7" at minute
 * 3, with nothing accounting for the six that moved; the truth at second 30
 * was "six rules have not been checked at all". The gate exists for exactly
 * the opening minutes, so the denominator is least trustworthy when this
 * banner is most likely to be read.
 *
 * So the denominator is named as CHECKED rules, and `sla.notJudged` is stated
 * beside it rather than left to be inferred from a number that moves. The
 * copy does not say WHY a rule was not judged -- too little data, no matching
 * statistic, an ambiguous target are all `not_applicable`, and the
 * assertion's own message on the finished run's page is where that belongs.
 *
 * ═══ AND AN ABSENT BANNER IS NOT ALWAYS GOOD NEWS ═══
 *
 * "all checked and fine", "nothing has enough data yet" and "the rules failed
 * to load" all used to render as nothing. The last of those is not transient:
 * a run's rules are read ONCE, at claim, and never retried for as long as the
 * owner holds it (`FoldState.rules`), so a failed load means this run is
 * being watched by nobody for its whole life. `sla.rulesUnavailable` is
 * therefore the one case where this component renders with NOTHING breaching
 * -- because "no breaches" is precisely what it cannot honestly say.
 *
 * `frozen` (TASK 9 C3's same flag, `Live`'s own `status !== 'running'`)
 * governs one word, not the whole banner: once streaming stops the fold
 * owner released this run and nothing evaluates it again, so "currently
 * breaching" is no longer quite true — it is the LAST known state, not a
 * live one. `LiveSummary`'s Duration tile already makes this exact
 * distinction ("still streaming" vs. "when streaming stopped") for the same
 * reason, and the two must never disagree about whether the run is live on
 * the same render. Optional and defaulted to `false` rather than required,
 * so a caller that genuinely has no notion of frozen (this component's own
 * unit tests, which assert the CONDITION-vs-EVENT behaviour and do not care
 * which tense the header reads in) is not forced to invent one.
 */
export default function SlaBanner({
  sla,
  frozen = false,
}: {
  readonly sla: LiveDelta['sla'];
  readonly frozen?: boolean;
}) {
  if (sla.breaching.length === 0 && !sla.rulesUnavailable) return null;

  return (
    <div
      role="status"
      data-testid="sla-banner"
      className="tint flex flex-col gap-2 rounded-xl border px-4 py-3 text-[13px]"
      style={{ color: ASSERTION_OUTCOME.failed.colour }}
    >
      {sla.rulesUnavailable ? (
        // A load failure leaves `assertions` empty, so there is never a breach
        // list to draw beside this -- and never a number to put in the
        // sentence above, which is the whole reason it needs its own.
        <p className="font-semibold">
          This run’s SLA rules could not be loaded, so nothing is being checked against them.
        </p>
      ) : (
        <>
          <p className="font-semibold">
            {sla.breaching.length} of {sla.evaluated} checked SLA{' '}
            {sla.evaluated === 1 ? 'rule' : 'rules'}{' '}
            {frozen ? 'breaching when streaming stopped' : 'currently breaching'}
          </p>
          <ul className="flex flex-col gap-1">
            {sla.breaching.map((rule) => (
              <li key={rule.ruleId}>
                {rule.description} — breaching since {formatOffset(rule.sinceOffsetMs)} into the run
              </li>
            ))}
          </ul>
          {sla.notJudged > 0 && (
            <p>
              {sla.notJudged} further{' '}
              {sla.notJudged === 1 ? 'rule has' : 'rules have'} not been checked yet.
            </p>
          )}
        </>
      )}
    </div>
  );
}
