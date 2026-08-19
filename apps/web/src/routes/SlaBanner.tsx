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
 * already carries for a failed assertion row, reached as DATA through an
 * inline `style` — the route `Login.tsx`'s own sign-in error takes, and the
 * reason this file needs no entry in `test/tokens.test.ts`'s exemption list
 * (that gate only catches the Tailwind arbitrary-value SPELLING of a token,
 * `[var(--…)]`, never a JS value read off `marks.tsx`'s own vocabulary).
 * `tint` (`styles/tokens.css`) turns that one colour into the wash and the
 * border, so there is no second failed-red hard-coded here.
 */
export default function SlaBanner({ sla }: { readonly sla: LiveDelta['sla'] }) {
  if (sla.breaching.length === 0) return null;

  return (
    <div
      role="status"
      data-testid="sla-banner"
      className="tint flex flex-col gap-2 rounded-xl border px-4 py-3 text-[13px]"
      style={{ color: ASSERTION_OUTCOME.failed.colour }}
    >
      <p className="font-semibold">
        {sla.breaching.length} of {sla.evaluated} SLA {sla.evaluated === 1 ? 'rule' : 'rules'}{' '}
        currently breaching
      </p>
      <ul className="flex flex-col gap-1">
        {sla.breaching.map((rule) => (
          <li key={rule.ruleId}>
            {rule.description} — breaching since {formatOffset(rule.sinceOffsetMs)} into the run
          </li>
        ))}
      </ul>
    </div>
  );
}
