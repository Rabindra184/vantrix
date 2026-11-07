import { useEffect, useRef } from 'react';
import type { PublicLinkRefusalCode } from '@perfportal/contracts';
import { formatInstant } from '../format';
import PublicHeader from './PublicHeader';
import type { PublicLinkRefusal } from './publicQueryClient';

/** An ISO 8601 instant, as the API writes one into `LINK_EXPIRED`'s detail. */
const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/;

/**
 * The sentence for each refusal, verbatim from the spec (6.1). A `Record` over
 * the codes, so a fifth refusal added to the contract is a compile error here
 * rather than a page that says nothing.
 *
 * The expired page's date is the API's own instant, read out of its detail
 * (`This link expired on <ISO 8601>.`) and written in the reader's clock. A
 * detail with no readable instant in it — a server that reworded its sentence
 * — still says the link expired rather than "expired on Invalid Date".
 */
const SENTENCE: Readonly<Record<PublicLinkRefusalCode, (detail: string) => string>> = {
  LINK_EXPIRED: (detail) => {
    const at = ISO_INSTANT.exec(detail)?.[0];
    return at !== undefined && !Number.isNaN(Date.parse(at))
      ? `This link expired on ${formatInstant(at)}.`
      : 'This link has expired.';
  },
  LINK_REVOKED: () => 'This link has been revoked.',
  PUBLIC_LINKS_DISABLED: () => 'Public links are turned off for this organisation.',
  LINK_NOT_FOUND: () => 'This link does not exist.',
};

/**
 * ═══ THE PAGE A REFUSED PUBLIC LINK OPENS ON ═══
 *
 * One sentence saying why the link does not read, then the one thing a reader
 * can do about any of them: "Ask whoever sent it for a new link." The four
 * reasons are kept apart because they tell the reader different things — a
 * revoked link never comes back, links turned off for the org may, an expired
 * one ran out.
 *
 * It REPLACES the whole page, including a run page the reader was in the
 * middle of reading when a section's read was refused (Review Focus 4), so the
 * sentence takes focus as it mounts: otherwise focus is left on a control that
 * no longer exists, and a screen reader says nothing at all. Nothing on it is
 * a link, for `PublicHeader`'s reason.
 */
export default function LinkUnavailable({ refusal }: { readonly refusal: PublicLinkRefusal }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    document.title = 'Link unavailable — PerfPortal';
  }, []);

  return (
    <div className="min-h-screen">
      <PublicHeader expiresAt={null} />
      <main id="main" className="min-w-0 p-4 sm:p-6">
        <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3 text-center">
          <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold tracking-tight text-primary outline-none">
            {SENTENCE[refusal.code](refusal.detail)}
          </h1>
          <p className="text-[0.8125rem] leading-relaxed text-muted">Ask whoever sent it for a new link.</p>
        </div>
      </main>
    </div>
  );
}
