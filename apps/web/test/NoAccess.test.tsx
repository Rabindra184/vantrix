import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NoAccess } from '../src/access/NoAccess';

/**
 * The sentences are written out here rather than read from `accessRefusal`:
 * a case that took its expectation from the function under test would prove
 * only that `NoAccess` calls it, and these two are the API's own refusal copy
 * (`AccessGuard`'s 403 answers with the same words), which is the claim.
 */

afterEach(cleanup);

/** The paragraphs inside the state, in order — so a third sentence, or a title, fails. */
function sentences(status: HTMLElement): string[] {
  return Array.from(status.querySelectorAll('p'), (p) => p.textContent ?? '');
}

describe('NoAccess', () => {
  it("says the API's own two sentences for an action a role allows, as the page's answer", () => {
    render(<NoAccess action="tokens:manage" />);

    const status = screen.getByRole('status');
    expect(sentences(status)).toEqual([
      'Managing API tokens needs the Manager role in this project.',
      'Ask an admin to change your role.',
    ]);
    // An answer, not an interruption.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names no role for an action only an admin may take', () => {
    render(<NoAccess action="projects:create" />);

    expect(sentences(screen.getByRole('status'))).toEqual(['Creating projects needs an admin.', 'Ask an admin to do this.']);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
