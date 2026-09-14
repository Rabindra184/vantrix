import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EmptyState, ErrorState, LoadingState } from '../src/components/States.js';

afterEach(cleanup);

/**
 * ═══ THE THREE STATES SEVENTEEN CALLERS SHARE ═══
 *
 * This file had no test of its own, which is how `TableFrame` — a component
 * six tables shared — came to wrap an interactive `<summary>` in
 * `aria-hidden="true"` and keep it through two reviews. These three are
 * imported by seventeen modules, and every claim below is one the component's
 * own docstring argues at length and nothing anywhere checked.
 *
 * They are all ACCESSIBILITY claims, and that is not a coincidence: what these
 * components decide is how a page INTERRUPTS somebody, which is invisible to
 * every assertion about the words on screen.
 */
describe('States — how loudly each one speaks', () => {
  /**
   * THE SPLIT IS THE WHOLE DESIGN. An alert interrupts a screen reader
   * mid-sentence. That is right for "your data did not load" and wrong for
   * "this project has no runs yet", which is not a failure at all — it is the
   * answer to the question the reader asked.
   *
   * Asserted as an EXCLUSIVE pair rather than two separate positives: a file
   * that gave every state `role="alert"` would satisfy "the error is an alert"
   * perfectly, and that is the regression worth catching.
   */
  it('makes the error an alert and the empty state none', () => {
    render(<ErrorState title="Could not load runs" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load runs');

    cleanup();
    render(<EmptyState title="No runs yet" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('No runs yet')).toBeInTheDocument();
  });

  /**
   * `role="status"` is polite and waits its turn. Waiting is not an error, and
   * a page that interrupts to say so on every navigation is worse than one
   * that says nothing.
   */
  it('announces loading politely, never as an alert', () => {
    render(<LoadingState label="Loading runs" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading runs');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * ONE SENTENCE, TWO READERS. With a skeleton on screen the label goes
   * `sr-only` — still announced, no longer drawn — so a sighted reader does
   * not meet "Loading runs" as text directly above a placeholder that says the
   * same thing in shapes.
   *
   * ASSERTED ON THE CLASS, and that is a deliberate weakness worth naming:
   * jsdom applies no stylesheet, so it cannot see that `sr-only` actually
   * hides anything — the same reason `truncate` and `max-sm:hidden` need a
   * browser elsewhere in this repo. What it CAN prove is that the two states
   * differ, and that the label survives into the accessibility tree in both,
   * which is the half a refactor is most likely to drop.
   */
  it('keeps the label announced but stops drawing it once a placeholder is there', () => {
    const { rerender } = render(<LoadingState label="Loading runs" />);
    expect(screen.getByRole('status')).not.toHaveClass('sr-only');

    rerender(
      <LoadingState label="Loading runs">
        <div data-testid="skeleton" />
      </LoadingState>,
    );
    const announced = screen.getByRole('status');
    expect(announced).toHaveClass('sr-only');
    expect(announced).toHaveTextContent('Loading runs');
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
  });
});

describe('States — what they will not say', () => {
  /**
   * NEVER INVENTS COPY. Every `/v1` error carries both a detail and a
   * remediation, and a caller that has neither — a transport failure, a schema
   * mismatch — passes neither. Substituting "please try again later" would
   * attribute to the server a sentence it never sent, and the reader cannot
   * tell the difference.
   *
   * The pair matters: the first half proves nothing is invented, and on its
   * own it is satisfied by a component that renders nothing at all.
   */
  it('renders no remediation when the caller has none, and the caller’s own when it does', () => {
    render(<ErrorState title="Could not load runs" />);
    const bare = screen.getByRole('alert').textContent ?? '';
    expect(bare).toBe('Could not load runs');

    cleanup();
    render(
      <ErrorState
        title="Could not load runs"
        detail="The server refused the request."
        remediation="Check the project slug and try again."
      />,
    );
    const full = screen.getByRole('alert');
    expect(full).toHaveTextContent('The server refused the request.');
    expect(full).toHaveTextContent('Check the project slug and try again.');
  });

  /**
   * A HEADING IS NOT A STYLE, which is what `titleAs` exists to keep true.
   * These states appear under a page that already renders its own `<h1>` and
   * in place of one that does not, so the ELEMENT has to differ while the
   * visual weight does not — `Title` gives every variant one class list for
   * exactly that reason.
   *
   * So this asserts the accessibility tree and the appearance TOGETHER: same
   * className, different role. Checking only the heading would pass against a
   * component that also made it visually bigger, which is the decision the
   * docstring forbids.
   */
  it('promotes the title to a real heading without changing how it looks', () => {
    render(<EmptyState title="No runs yet" />);
    const asParagraph = screen.getByText('No runs yet');
    expect(asParagraph.tagName).toBe('P');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    const paragraphClass = asParagraph.className;

    cleanup();
    render(<EmptyState title="No runs yet" titleAs="h2" />);
    const asHeading = screen.getByRole('heading', { level: 2, name: 'No runs yet' });
    expect(asHeading.className).toBe(paragraphClass);
  });
});
