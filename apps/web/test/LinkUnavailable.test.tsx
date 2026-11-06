import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_LINK_REFUSAL_CODES, type PublicLinkRefusalCode } from '@perfportal/contracts';
import LinkUnavailable from '../src/routes/share/LinkUnavailable';
import { formatInstant } from '../src/routes/format';

/**
 * ═══ ONE SENTENCE PER REASON, AND THE SAME REQUEST AFTER EACH ═══
 *
 * The page a refused public link opens on (spec 6.1). The words are the spec's
 * verbatim, so a reader told "revoked" and a reader told "turned off" know
 * whether the link can ever come back; every page then asks them to get a new
 * one from whoever sent it.
 *
 * The expired page's date is the API's own instant, carried in the refusal's
 * `detail` as ISO 8601, written in the reader's clock by `formatInstant` — the
 * one spelling the run page uses for an instant.
 */

afterEach(cleanup);

const EXPIRED_AT = '2026-11-13T09:30:00.000Z';

const DETAIL: Readonly<Record<PublicLinkRefusalCode, string>> = {
  LINK_NOT_FOUND: 'This link does not exist.',
  LINK_REVOKED: 'This link has been revoked.',
  PUBLIC_LINKS_DISABLED: 'Public links are turned off for this organisation.',
  LINK_EXPIRED: `This link expired on ${EXPIRED_AT}.`,
};

const SENTENCE: Readonly<Record<PublicLinkRefusalCode, string>> = {
  LINK_NOT_FOUND: 'This link does not exist.',
  LINK_REVOKED: 'This link has been revoked.',
  PUBLIC_LINKS_DISABLED: 'Public links are turned off for this organisation.',
  LINK_EXPIRED: `This link expired on ${formatInstant(EXPIRED_AT)}.`,
};

describe('LinkUnavailable', () => {
  it.each(PUBLIC_LINK_REFUSAL_CODES)('says why a %s link cannot be read, and what to do about it', (code) => {
    render(<LinkUnavailable refusal={{ code, detail: DETAIL[code] }} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(SENTENCE[code]);
    expect(screen.getByText('Ask whoever sent it for a new link.')).toBeInTheDocument();
  });

  it('writes the expiry in the reader’s clock, never as the raw instant', () => {
    render(<LinkUnavailable refusal={{ code: 'LINK_EXPIRED', detail: DETAIL.LINK_EXPIRED }} />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(`This link expired on ${formatInstant(EXPIRED_AT)}.`);
    expect(heading.textContent).not.toContain(EXPIRED_AT);
  });

  /** A detail with no instant in it (an API that reworded its sentence) still
   *  says the link expired, rather than printing "expired on Invalid Date". */
  it('says the link expired when the refusal names no instant', () => {
    render(<LinkUnavailable refusal={{ code: 'LINK_EXPIRED', detail: 'Expired.' }} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('This link has expired.');
  });

  /** The page has no route back into the app: a link to anywhere outside
   *  `/share/<secret>` would be one a stranger meets a sign-in page behind. */
  it('carries no link at all, and names the product as text', () => {
    const { container } = render(
      <LinkUnavailable refusal={{ code: 'LINK_REVOKED', detail: DETAIL.LINK_REVOKED }} />,
    );
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(screen.getByText('PerfPortal')).toBeInTheDocument();
  });

  /** It replaces a page the reader may be in the middle of reading, so focus
   *  goes to the sentence rather than being left on a control that is gone. */
  it('moves focus to its sentence', () => {
    render(<LinkUnavailable refusal={{ code: 'LINK_REVOKED', detail: DETAIL.LINK_REVOKED }} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });
});
