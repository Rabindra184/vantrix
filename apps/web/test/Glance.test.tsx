import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActivityResponse } from '@perfportal/contracts';
import Glance from '../src/home/Glance';

afterEach(cleanup);

/**
 * ═══ SEVEN COLUMNS A READER CAN HEAR ═══
 *
 * The glance is a figure of bars, and a bar is invisible to a screen reader, so
 * every number it draws is also a sentence. The sentences are built here with
 * the SAME `Intl` call the component uses and read off the payload — a label
 * written down as "Tue, 6 Oct" would pass in one locale and one zone and fail
 * on a runner in another, for a reason that is not a defect.
 *
 * jsdom lays out nothing, so what these cases can prove is the numbers handed
 * to the browser (heights, order, colours) and the markup's promises (named,
 * hidden, unfocusable). That the bars LOOK right is `home.spec.ts`'s.
 */
type Days = ActivityResponse['days'];

const WEEK: Days = [
  { date: '2026-09-30', total: 0, successful: 0, needsAttention: 0 },
  { date: '2026-10-01', total: 2, successful: 2, needsAttention: 0 },
  // Two finished well, one needs attention and one is still in flight: the
  // only day whose segments are all three, so the stack order is checkable.
  { date: '2026-10-02', total: 4, successful: 2, needsAttention: 1 },
  { date: '2026-10-03', total: 1, successful: 0, needsAttention: 1 },
  { date: '2026-10-04', total: 0, successful: 0, needsAttention: 0 },
  { date: '2026-10-05', total: 3, successful: 3, needsAttention: 0 },
  { date: '2026-10-06', total: 4, successful: 4, needsAttention: 0 },
];

const labelFor = (date: string): string =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));

const sentenceFor = (day: Days[number]): string => {
  if (day.total === 0) return `${labelFor(day.date)}: no runs.`;
  const runs = `${day.total} ${day.total === 1 ? 'run' : 'runs'}`;
  const needs = `${day.needsAttention} ${day.needsAttention === 1 ? 'needs' : 'need'} attention`;
  return `${labelFor(day.date)}: ${runs}, ${day.successful} successful, ${needs}.`;
};

const BUSIEST = Math.max(...WEEK.map((d) => d.total));
const day = (date: string): Days[number] => WEEK.find((d) => d.date === date)!;

describe('Glance', () => {
  it('is one figure named for what it counts, with a column per day', () => {
    render(<Glance days={WEEK} />);
    const figure = screen.getByRole('figure', { name: 'Runs per day' });
    expect(within(figure).getAllByRole('listitem')).toHaveLength(7);
  });

  it('says every day in one sentence a screen reader gets and a sighted reader does not', () => {
    render(<Glance days={WEEK} />);
    for (const d of WEEK) {
      const sentence = screen.getByText(sentenceFor(d));
      expect(sentence).toHaveClass('sr-only');
    }
    // Singular where the count is one: "1 run", "1 needs attention".
    expect(screen.getByText(sentenceFor(day('2026-10-03')))).toHaveTextContent(
      /1 run, 0 successful, 1 needs attention\.$/,
    );
  });

  it('draws the busiest day at the full height and every other in proportion to it', () => {
    render(<Glance days={WEEK} />);
    const height = (date: string) => screen.getByTestId(`glance-bar-${date}`).style.height;

    expect(height('2026-10-02')).toBe('100%');
    expect(height('2026-10-06')).toBe('100%');
    expect(height('2026-10-01')).toBe('50%');
    for (const d of WEEK.filter((x) => x.total > 0)) {
      expect(height(d.date), d.date).toBe(`${(d.total / BUSIEST) * 100}%`);
    }
  });

  it('stacks successful, then needs attention, then the in-flight remainder, bottom-up', () => {
    render(<Glance days={WEEK} />);
    const d = day('2026-10-02');
    const bar = screen.getByTestId(`glance-bar-${d.date}`);

    // `flex-col-reverse`: the FIRST child is the bottom of the stack.
    const segments = [...bar.children] as HTMLElement[];
    expect(segments.map((s) => s.dataset.segment)).toEqual(['successful', 'attention', 'in-flight']);

    const inFlight = d.total - d.successful - d.needsAttention;
    expect(inFlight).toBeGreaterThan(0);
    const share = (n: number) => `${(n / d.total) * 100}%`;
    expect(segments.map((s) => s.style.height)).toEqual([
      share(d.successful),
      share(d.needsAttention),
      share(inFlight),
    ]);
    expect(segments.map((s) => s.style.background)).toEqual([
      'var(--color-status-passed)',
      'var(--color-status-failed)',
      'var(--color-status-not-applicable)',
    ]);
  });

  it('draws no segment for a count of zero, so a bar is only the colours it has', () => {
    render(<Glance days={WEEK} />);
    const clean = screen.getByTestId('glance-bar-2026-10-06');
    expect([...clean.children].map((s) => (s as HTMLElement).dataset.segment)).toEqual(['successful']);
    const failed = screen.getByTestId('glance-bar-2026-10-03');
    expect([...failed.children].map((s) => (s as HTMLElement).dataset.segment)).toEqual(['attention']);
  });

  it('says "no runs" for an empty day and hatches it instead of drawing a bar', () => {
    render(<Glance days={WEEK} />);
    const empty = day('2026-10-04');
    expect(screen.getByText(sentenceFor(empty))).toHaveTextContent(/no runs\.$/);

    expect(screen.queryByTestId(`glance-bar-${empty.date}`)).toBeNull();
    const hatch = screen.getByTestId(`glance-empty-${empty.date}`);
    expect(hatch.getAttribute('style')).toContain('repeating-linear-gradient');
    // The real runtime token, not one that does not exist: a hatch over an
    // undefined variable draws nothing and nothing fails.
    expect(hatch.getAttribute('style')).toContain('var(--color-border)');
    // And a day WITH runs is not hatched.
    expect(screen.queryByTestId('glance-empty-2026-10-06')).toBeNull();
  });

  it('labels each column with its own date and repeats its numbers on hover, hidden from assistive technology', () => {
    render(<Glance days={WEEK} />);
    for (const d of WEEK) {
      const column = screen.getByTestId(`glance-day-${d.date}`);
      // The visible label is the same words the sentence leads with.
      const visible = [...column.querySelectorAll('[aria-hidden="true"]')].find(
        (el) => el.textContent === labelFor(d.date),
      );
      expect(visible, `label for ${d.date}`).toBeDefined();

      const hover = screen.getByTestId(`glance-hover-${d.date}`);
      expect(hover).toHaveAttribute('aria-hidden', 'true');
      if (d.total === 0) {
        expect(hover).toHaveTextContent('No runs');
      } else {
        expect(hover).toHaveTextContent(String(d.total));
        expect(hover).toHaveTextContent(`${d.successful} successful`);
        expect(hover).toHaveTextContent(`${d.needsAttention} ${d.needsAttention === 1 ? 'needs' : 'need'} attention`);
      }
    }
  });

  it('puts nothing in the tab order and leans on no title', () => {
    const { container } = render(<Glance days={WEEK} />);
    expect(
      container.querySelectorAll(
        'a, button, input, select, textarea, summary, [tabindex], [contenteditable], [title]',
      ),
    ).toHaveLength(0);
  });

  it('survives a week with no runs at all, with no NaN height anywhere', () => {
    const quiet: Days = WEEK.map((d) => ({ ...d, total: 0, successful: 0, needsAttention: 0 }));
    const { container } = render(<Glance days={quiet} />);
    expect(container.innerHTML).not.toContain('NaN');
    expect(screen.getAllByText(/: no runs\.$/)).toHaveLength(7);
    expect(container.querySelectorAll('[data-testid^="glance-bar-"]')).toHaveLength(0);
  });
});
