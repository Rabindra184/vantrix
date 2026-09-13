// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import TableFrame from '../src/components/TableFrame';

afterEach(cleanup);

/**
 * ═══ REVIEW 09-13 C06 — A FOCUSABLE CONTROL INSIDE `aria-hidden` ═══
 *
 * `TableFrame` wraps every table in this app. Its visible caption block was
 * marked `aria-hidden="true"` for a good reason — the table's own
 * `<caption class="sr-only">` carries the same words, so announcing them twice
 * is noise — and then the block grew a `<details>`/`<summary>` disclosure.
 *
 * A `<summary>` is interactive and focusable. `aria-hidden` removes an element
 * from the accessibility tree WITHOUT removing it from the tab order, so the
 * combination produces the one thing the attribute must never produce: a tab
 * stop a screen reader cannot describe. The fix is not to un-hide everything —
 * the duplicate-prose argument still holds for the paragraph — but to put the
 * attribute only where that argument applies.
 *
 * ═══ WHY THIS FILE EXISTS AT ALL ═══
 *
 * `TableFrame` had no test. Six tables share it, the defect was invisible to
 * every one of their suites, and it was introduced by a change whose own
 * review reasoned carefully about this exact attribute one component over —
 * `RunCards` deliberately does NOT copy the `aria-hidden`, and the note saying
 * so is three lines from the bug. Reasoning about half of a rule is how it
 * survives being read.
 */
function renderFrame(props: { summary?: string } = {}) {
  return render(
    <TableFrame
      caption="Statistics for every request in this run. Percentiles are estimates."
      label="Statistics table"
      {...(props.summary === undefined ? {} : { summary: props.summary })}
    >
      <table>
        <caption className="sr-only">
          Statistics for every request in this run. Percentiles are estimates.
        </caption>
        <tbody>
          <tr>
            <td>1</td>
          </tr>
        </tbody>
      </table>
    </TableFrame>,
  );
}

/**
 * Every element a keyboard can reach, paired with whether anything above it
 * hides it from assistive technology. The invariant is that no pair is ever
 * `[focusable, hidden]` — stated generally rather than as "the summary is not
 * inside the div", so it still holds when the markup is rearranged.
 */
function focusableInsideAriaHidden(root: HTMLElement): string[] {
  const focusable = root.querySelectorAll<HTMLElement>(
    'a[href], button, summary, input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  return [...focusable]
    .filter((el) => el.closest('[aria-hidden="true"]') !== null)
    .map((el) => el.tagName.toLowerCase());
}

describe('TableFrame — the caption block', () => {
  it('never leaves a focusable control inside an aria-hidden subtree', () => {
    const { container } = renderFrame({ summary: 'Every request, newest first.' });
    expect(focusableInsideAriaHidden(container)).toEqual([]);
  });

  /** The scroll box is `tabIndex={0}` so a keyboard can scroll a wide table.
   *  It is outside the caption block and must stay reachable — the check above
   *  would pass just as well if the whole frame stopped being focusable, so
   *  this pins that it did not. */
  it('keeps the scroll region reachable by keyboard', () => {
    renderFrame({ summary: 'Every request, newest first.' });
    expect(screen.getByRole('region', { name: 'Statistics table' })).toHaveAttribute(
      'tabindex',
      '0',
    );
  });

  /**
   * THE DISCLOSURE IS THE POINT: it must be operable, and by the browser's own
   * keyboard behaviour rather than a hand-rolled one.
   */
  it('exposes the disclosure to assistive technology, open and closed', async () => {
    const user = userEvent.setup();
    renderFrame({ summary: 'Every request, newest first.' });

    const details = screen.getByRole('group');
    expect(details).not.toHaveAttribute('open');
    await user.click(screen.getByText('How these numbers are counted'));
    expect(details).toHaveAttribute('open');
  });

  /**
   * AND THE REASON THE ATTRIBUTE EXISTED IS PRESERVED. The visible short line
   * repeats the table's own `<caption>`, so it stays hidden — dropping
   * `aria-hidden` everywhere would have "fixed" the defect by making a screen
   * reader read the same sentence twice on every table in the app.
   */
  it('still hides the visible copy that the caption already carries', () => {
    const { container } = renderFrame({ summary: 'Every request, newest first.' });
    const line = screen.getByText('Every request, newest first.');
    expect(line.closest('[aria-hidden="true"]')).not.toBeNull();
    // And exactly one thing is hidden — not the whole block again.
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });

  /** With no `summary` there is no disclosure and nothing interactive, so the
   *  whole caption may stay hidden — the original arrangement, still correct
   *  for the case it was written for. */
  it('hides the caption outright when there is no disclosure', () => {
    const { container } = renderFrame();
    expect(screen.queryByRole('group')).toBeNull();
    expect(focusableInsideAriaHidden(container)).toEqual([]);
  });
});
