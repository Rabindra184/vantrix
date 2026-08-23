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

  it('renders the description under the title when both are given', () => {
    render(<Card title="Requests" description="per second">{null}</Card>);
    expect(screen.getByRole('heading', { name: 'Requests' })).toBeInTheDocument();
    expect(screen.getByText('per second')).toBeInTheDocument();
  });
});
