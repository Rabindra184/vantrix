import { useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from './icons';

/**
 * ═══ A MACHINE ID, ONE CLICK FROM A LIST ROW ═══
 * (backlog item #4 of the Gatling Enterprise comparison)
 *
 * Gatling Enterprise's Tests page puts a copyable id beside every test, for
 * the reader who is about to script against it. Here: the run list copies a
 * run's FULL id (what every `/v1/runs/{id}` endpoint takes — the list shows an
 * 8-character prefix at most, which nothing accepts), and the tests catalogue
 * copies a test's slug (what an upload's or runner job's `test` field takes).
 *
 * NAMED AFTER ITS ROW. A page of twenty-five buttons all called "Copy" is the
 * duplicate-name defect this repo has paid for three times, so the caller
 * passes the whole name — "Copy run id 3764bc74-…".
 *
 * ALWAYS VISIBLE, never revealed on hover: a hover-only control does not exist
 * on a touch screen and is invisible to a keyboard user until they land on it.
 * It is muted until hovered, so twenty-five of them do not shout.
 *
 * ═══ A STATUS EXISTS ONLY WHILE THERE IS ONE ═══
 *
 * The run list renders this once per row. Twenty-five permanently-empty
 * `role="status"` elements make every page-wide status query answer a
 * different question — the rule `ChartActions` records, for the same reason:
 * a component rendered N times a page must not contribute N always-present
 * live regions. Success is announced (the icon has already turned into a
 * tick for a sighted reader) and lapses after two seconds.
 *
 * ═══ AND IT NEVER CLAIMS A COPY THAT DID NOT HAPPEN ═══
 *
 * A plain-http page has no Clipboard API at all — an ordinary way to reach an
 * on-prem install, and precisely what `PERFPORTAL_ALLOW_INSECURE_COOKIES`
 * exists for — and a secure page can still refuse the write. Optional-chaining
 * `navigator.clipboard` would make `await undefined` resolve and report
 * success, which is the bug the token screen shipped once. Both failures end
 * in one honest state: the value is on screen, selectable, with nothing
 * claimed about WHY — the reader's next step is the same either way.
 */
type CopyState = 'idle' | 'copied' | 'failed';

export default function CopyIdButton({
  value,
  label,
  size,
}: {
  /** Exactly what lands on the clipboard. */
  readonly value: string;
  /** The button's accessible name, naming its row: "Copy run id <id>". */
  readonly label: string;
  /**
   * `touch` on the phone card, where a finger has to hit it; `row` in a
   * table cell, still the 24 px WCAG 2.5.8 floor. Required, because the
   * wrong one is silent — a 24 px target on a phone looks fine in every
   * test that does not tap it.
   */
  readonly size: 'row' | 'touch';
}) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The acknowledgement is transient, and a row unmounted before it lapses
  // (a page change, a filter) must not set state afterwards.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    if (timer.current !== null) clearTimeout(timer.current);
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') {
        throw new Error('The clipboard is not available on this page.');
      }
      await navigator.clipboard.writeText(value);
    } catch {
      setState('failed');
      return;
    }
    setState('copied');
    timer.current = setTimeout(() => setState('idle'), 2000);
  };

  const box = size === 'touch' ? 'h-9 w-9' : 'h-6 w-6';
  const glyph = size === 'touch' ? 'h-4 w-4' : 'h-3.5 w-3.5';

  return (
    <>
      <button
        type="button"
        onClick={copy}
        aria-label={label}
        title={label}
        data-testid="copy-id"
        className={`transition-ui ml-1 inline-flex ${box} shrink-0 items-center justify-center rounded-md align-middle text-muted hover:bg-sunken hover:text-primary`}
      >
        {state === 'copied' ? <CheckIcon className={glyph} /> : <CopyIcon className={glyph} />}
      </button>
      {state === 'copied' && (
        <span role="status" className="sr-only">
          Copied.
        </span>
      )}
      {state === 'failed' && (
        <span role="status" className="ml-1 text-[0.6875rem] font-normal text-muted">
          Not copied — select it here:{' '}
          <code className="select-all break-all text-primary">{value}</code>
        </span>
      )}
    </>
  );
}
