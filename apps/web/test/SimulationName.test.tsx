import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import SimulationName, { namePieces } from '../src/routes/SimulationName';

afterEach(cleanup);

/**
 * ═══ THE CLASS LEADS, AND A LINE ENDS ONLY AT A WORD (clean UI, PR 3) ═══
 *
 * The run lists' name cell was `break-all`, so a fully qualified class broke
 * wherever the column ran out — "example.P / aritySimul / ation". Every
 * break-free piece is its own `whitespace-nowrap` span joined by `<wbr>`, so a
 * line can end only after a package segment's dot or between two camelCase
 * words. Whether each piece really stays on one line is a layout claim, and
 * jsdom lays out nothing: `run-list.spec.ts` measures it in a browser.
 */
describe('namePieces', () => {
  it('splits the package from the class and the class at its words', () => {
    expect(namePieces('com.acme.checkout.CheckoutPeakLoadSimulation')).toEqual({
      package: ['com.', 'acme.', 'checkout.'],
      className: ['Checkout', 'Peak', 'Load', 'Simulation'],
    });
  });

  it('keeps a name with no dot and no word boundary as one piece', () => {
    expect(namePieces('loadtest')).toEqual({ package: [], className: ['loadtest'] });
  });

  it('splits after a digit as well as a lower-case letter', () => {
    expect(namePieces('v2Smoke').className).toEqual(['v2', 'Smoke']);
  });
});

describe('SimulationName', () => {
  it('renders text that rejoins to the full name, with no break-all', () => {
    const { container } = render(<SimulationName name="example.ParitySimulation" />);
    expect(container.textContent).toBe('example.ParitySimulation');
    expect(container.querySelector('.break-all')).toBeNull();
    expect(container.querySelectorAll('wbr').length).toBeGreaterThan(0);
    const pieces = container.querySelectorAll('[data-name-piece]');
    expect(pieces.length).toBe(3);
    for (const piece of pieces) expect(piece).toHaveClass('whitespace-nowrap');
  });

  it('draws the package as its own muted line and omits it when there is none', () => {
    const { container, rerender } = render(<SimulationName name="example.ParitySimulation" />);
    expect(container.querySelector('[data-name-package]')).toHaveTextContent(/^example\.$/);
    rerender(<SimulationName name="loadtest" />);
    expect(container.querySelector('[data-name-package]')).toBeNull();
    expect(container.querySelector('wbr')).toBeNull();
    expect(container.textContent).toBe('loadtest');
  });
});
