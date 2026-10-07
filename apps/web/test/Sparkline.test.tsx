import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import Sparkline from '../src/home/Sparkline';

/**
 * ═══ A p95 HISTORY, DRAWN WITHOUT A CHART LIBRARY ═══
 *
 * The line is decoration for a sighted reader and the cell carries the facts:
 * the latest value as text, and a visually hidden summary of the range. So
 * what is asserted here is the geometry's SHAPE (how many points, which way is
 * up, no NaN on a flat history) and the words, never pixel positions — those
 * are the layout's, and a figure that moves a pixel is not a defect.
 *
 * Every expectation is computed from the points handed in.
 */
afterEach(cleanup);

const pts = (...values: number[]) => values.map((p95Ms) => ({ p95Ms }));

function draw(values: number[], lastNeedsAttention = false) {
  const utils = render(<Sparkline points={pts(...values)} lastNeedsAttention={lastNeedsAttention} />);
  return {
    ...utils,
    svg: utils.container.querySelector('svg'),
    polyline: utils.container.querySelector('polyline'),
    circle: utils.container.querySelector('circle'),
  };
}

/** The `points` attribute as `[x, y]` pairs. */
const coordinates = (polyline: Element | null): [number, number][] =>
  (polyline?.getAttribute('points') ?? '')
    .split(' ')
    .filter((pair) => pair !== '')
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return [x!, y!];
    });

describe('Sparkline', () => {
  it.each([[2], [3], [10]])('draws one vertex per point for a history of %i', (n) => {
    const values = Array.from({ length: n }, (_, i) => 100 + i * 37);
    const { polyline } = draw(values);
    expect(coordinates(polyline)).toHaveLength(values.length);
  });

  it('is decoration: the figure is hidden from assistive technology, and its words are not', () => {
    const { svg } = draw([610, 700, 812]);
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
    expect(screen.getByText(/^last 3 runs:/)).not.toHaveAttribute('aria-hidden');
  });

  it('draws a larger p95 higher up, and later runs further right', () => {
    const values = [200, 900, 400];
    const { polyline } = draw(values);
    const xy = coordinates(polyline);
    // SVG's y grows DOWNWARD: the slowest run must have the smallest y.
    const ys = xy.map(([, y]) => y);
    expect(ys.indexOf(Math.min(...ys))).toBe(values.indexOf(Math.max(...values)));
    expect(ys.indexOf(Math.max(...ys))).toBe(values.indexOf(Math.min(...values)));
    const xs = xy.map(([x]) => x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(xs.length);
  });

  it('keeps every vertex finite and inside the 80 × 24 box, including for a flat history', () => {
    for (const values of [[300, 300, 300], [0, 0], [1, 1_000_000], [450.5, 12.25, 99]]) {
      cleanup();
      const { svg, polyline } = draw(values);
      expect(svg).toHaveAttribute('viewBox', '0 0 80 24');
      for (const [x, y] of coordinates(polyline)) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(80);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(24);
      }
    }
  });

  it('shows the latest value as text, rounded', () => {
    draw([610.4, 700, 812.6]);
    expect(screen.getByText(`${Math.round(812.6)} ms`)).toBeInTheDocument();
  });

  it('summarises the range for a screen reader from the points themselves, not from their order', () => {
    // Neither the first nor the last point is the extreme.
    const values = [300, 120.4, 812.6, 640];
    draw(values);
    expect(
      screen.getByText(
        `last ${values.length} runs: ${Math.round(Math.min(...values))}–${Math.round(Math.max(...values))} ms`,
      ),
    ).toBeInTheDocument();
  });

  it('says a single value once, and in the singular', () => {
    draw([120.4]);
    expect(screen.getByText('last 1 run: 120 ms')).toBeInTheDocument();
  });

  it('collapses a range that rounds to one number instead of printing it twice', () => {
    draw([199.6, 200.2, 200.4]);
    expect(screen.getByText('last 3 runs: 200 ms')).toBeInTheDocument();
  });

  describe('the last point', () => {
    const lastCircle = (container: HTMLElement) => {
      const circles = container.querySelectorAll('circle');
      return circles[circles.length - 1] ?? null;
    };

    it('takes the failed colour only when that run needs attention', () => {
      const flagged = draw([610, 700, 812], true);
      expect(lastCircle(flagged.container)?.style.fill).toBe('var(--color-status-failed)');
      cleanup();

      const fine = draw([610, 700, 812], false);
      expect(lastCircle(fine.container)).not.toBeNull();
      expect(lastCircle(fine.container)?.style.fill).not.toContain('--color-status-failed');
    });

    it('sits on the last vertex of the line', () => {
      const { polyline, container } = draw([610, 700, 812], true);
      const [lastX, lastY] = coordinates(polyline).at(-1)!;
      const circle = lastCircle(container)!;
      expect(Number(circle.getAttribute('cx'))).toBeCloseTo(lastX, 5);
      expect(Number(circle.getAttribute('cy'))).toBeCloseTo(lastY, 5);
    });

    it('is drawn alone, as a dot, when there is only one point', () => {
      const { polyline, circle, svg } = draw([120], true);
      expect(svg).not.toBeNull();
      expect(polyline).toBeNull();
      expect(circle).not.toBeNull();
      expect(circle?.style.fill).toBe('var(--color-status-failed)');
    });

    it('is the only coloured mark: the line itself never takes a status colour', () => {
      const { polyline } = draw([610, 700, 812], true);
      expect(polyline?.getAttribute('style') ?? '').not.toContain('--color-status');
    });
  });

  describe('with no points', () => {
    it('draws no figure and says so in words', () => {
      const { container } = draw([]);
      expect(container.querySelector('svg')).toBeNull();
      expect(screen.getByText('—')).toBeInTheDocument();
      expect(screen.getByText('No completed runs with a p95')).toBeInTheDocument();
      expect(container.textContent).not.toMatch(/NaN|Infinity|undefined/);
    });
  });
});
