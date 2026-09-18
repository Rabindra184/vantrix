import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import Card from '../src/components/Card';

// ═══ WITHOUT THIS THE FILE LEAKS DOM BETWEEN CASES ═══
//
// `vitest.config.ts` does not set `globals`, so Testing Library's automatic
// cleanup never registers — every file has to call it itself, and this one
// did not. Each `render` appends to the same `document.body`, so a query in
// one test can resolve an element another test mounted.
//
// It is INTERMITTENT rather than always wrong, which is what made it hard to
// see: an earlier test's `useQuery` can resolve after that test has ended and
// commit into its still-attached container, so whether the stale node exists
// depends on timing. CLAUDE.md carried the resulting failure as "one
// occurrence, mechanism undiagnosed"; this is the mechanism.
afterEach(cleanup);


describe('Card', () => {
  it('renders its children inside the element the caller asked for', () => {
    const { container } = render(<Card as="figure"><p>body</p></Card>);
    expect(container.querySelector('figure')).not.toBeNull();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  /**
   * `Chart` renders its own <h3> and the e2e suite locates charts by it. A Card
   * that always drew a heading would give every chart two.
   */
  it('renders no heading when given no title', () => {
    render(<Card><p>body</p></Card>);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  /**
   * ═══ THE SIZE FOLLOWS THE LEVEL, NOT THE COMPONENT (review.md 20) ═══
   *
   * `SectionHeading`'s docstring states the ladder as 20/24 → 16 → 15px:
   * page `<h1>`, section `<h2>`, card `<h3>`. This component drew every title
   * at 15px whatever level the caller asked for — so the eight call sites that
   * pass `headingLevel={2}` rendered a SECTION heading at the CARD rung, and
   * one heading level appeared at two sizes depending on which component drew
   * it.
   *
   * ASSERTED AS A PAIR, because either alone passes against a component that
   * ignores the level entirely — one sizing everything 16px satisfies the
   * first, one sizing everything 15px satisfies the second. What is being
   * pinned is that the two DIFFER, and which way round.
   */
  it('draws a section-level title at the section rung and a card-level one at the card rung', () => {
    const { unmount } = render(<Card headingLevel={2} title="Add results"><p>body</p></Card>);
    expect(screen.getByRole('heading', { level: 2, name: 'Add results' })).toHaveClass('text-base');
    unmount();

    render(<Card title="Response time"><p>body</p></Card>);
    const card = screen.getByRole('heading', { level: 3, name: 'Response time' });
    expect(card).toHaveClass('text-[0.9375rem]');
    expect(card).not.toHaveClass('text-base');
  });

  it('renders the description under the title when both are given', () => {
    render(<Card title="Requests" description="per second">{null}</Card>);
    expect(screen.getByRole('heading', { name: 'Requests' })).toBeInTheDocument();
    expect(screen.getByText('per second')).toBeInTheDocument();
  });
});
