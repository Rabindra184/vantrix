import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Approx } from '../src/components/Approx';

afterEach(cleanup);

/**
 * ≈ marks a figure an estimated run produced. It is drawn for the eye and
 * SPOKEN as a word: a screen reader reading "≈" aloud says "almost equal to"
 * or nothing at all, so the glyph is hidden from the accessibility tree and
 * "approximately" carries the claim instead.
 */
describe('Approx', () => {
  it('marks nothing on an exact run', () => {
    render(
      <p data-testid="figure">
        <Approx exact>95th</Approx>
      </p>,
    );
    const figure = screen.getByTestId('figure');
    expect(figure.textContent).toBe('95th');
    expect(figure.textContent).not.toMatch(/≈|approximately/);
  });

  it('draws ≈ and says "approximately" on an estimated run', () => {
    render(
      <table>
        <thead>
          <tr>
            <th scope="col">
              <Approx exact={false}>95th</Approx>
            </th>
          </tr>
        </thead>
      </table>,
    );
    const header = screen.getByRole('columnheader');
    expect(header.textContent).toContain('≈');
    // The accessible name skips the aria-hidden glyph and keeps the word.
    expect(header).toHaveAccessibleName('approximately 95th');
  });
});
