// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import TableFrame from '../src/components/TableFrame';

afterEach(cleanup);

/**
 * ═══ THE FRAME DRAWS NO CAPTION (clean UI, PR 1) ═══
 *
 * `TableFrame` wraps every table in this app. It used to print each table's
 * caption — a paragraph of methodology, or a short line with the paragraph
 * behind a "How these numbers are counted" disclosure — above the numbers on
 * every visit. Under the clean-UI text rule
 * (docs/superpowers/specs/2026-10-04-clean-ui-design.md) a table's accessible
 * NAME is a few words, and a caveat that changes how the table should be read
 * rides behind an `InfoTip` named after it.
 *
 * ═══ AND THE C06 GUARD STAYS ═══
 *
 * Review 09-13 C06 found a focusable `<summary>` inside an `aria-hidden`
 * subtree here: a tab stop a screen reader cannot describe. The disclosure is
 * gone, but the invariant is general — no keyboard-reachable element under an
 * `aria-hidden` ancestor — so it keeps guarding whatever the frame draws next.
 */
function renderFrame(props: { name?: string; info?: string } = {}) {
  const name = props.name ?? 'Statistics';
  return render(
    <TableFrame name={name} label="Statistics table" info={props.info}>
      <table>
        <caption className="sr-only">{name}</caption>
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
 * `[focusable, hidden]` — stated generally, so it still holds when the markup
 * is rearranged.
 */
function focusableInsideAriaHidden(root: HTMLElement): string[] {
  const focusable = root.querySelectorAll<HTMLElement>(
    'a[href], button, summary, input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  return [...focusable]
    .filter((el) => el.closest('[aria-hidden="true"]') !== null)
    .map((el) => el.tagName.toLowerCase());
}

describe('TableFrame', () => {
  it('draws no visible caption and names the table with its short name', () => {
    renderFrame();
    expect(screen.getByRole('table', { name: 'Statistics' })).toBeInTheDocument();
    expect(screen.queryByText(/How these numbers are counted/)).toBeNull();
  });

  it('puts its caveat behind an InfoTip named after the table', () => {
    renderFrame({ info: 'Times are in milliseconds.' });
    expect(screen.getByRole('button', { name: 'About Statistics' })).toHaveAccessibleDescription(
      'Times are in milliseconds.',
    );
  });

  it('adds no row and no trigger without a caveat', () => {
    const { container } = renderFrame();
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('[data-testid="table-info"]')).toBeNull();
  });

  it('never leaves a focusable control inside an aria-hidden subtree', () => {
    const { container } = renderFrame({ info: 'Times are in milliseconds.' });
    expect(focusableInsideAriaHidden(container)).toEqual([]);
  });

  /** The scroll box is `tabIndex={0}` so a keyboard can scroll a wide table;
   *  the guard above would pass just as well if the frame stopped being
   *  focusable, so this pins that it did not. */
  it('keeps the scroll region reachable by keyboard', () => {
    renderFrame();
    expect(screen.getByRole('region', { name: 'Statistics table' })).toHaveAttribute('tabindex', '0');
  });
});
