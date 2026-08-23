import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Payload, TableSection, type Slot } from '../src/routes/payload';

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


const SLOTS: readonly Slot[] = [{ id: 'scatter', title: 'A chart' }];

const pending = { data: undefined, isPending: true, error: null } as never;
const failed = { data: undefined, isPending: false, error: new Error('nope') } as never;

describe('Payload', () => {
  it('renders the chart when the payload arrived', () => {
    // `<Payload<number>` pins T explicitly: `query`'s value is asserted `as
    // never` (the same trick `pending`/`failed` use above) so it need not
    // satisfy `UseQueryResult`'s full discriminated-union shape, but that
    // erases the structural information generic inference would otherwise
    // read T from — leaving `n` typed `unknown` and unassignable to
    // `ReactNode` below. The explicit argument is a type-only annotation; it
    // changes nothing about what this test renders or asserts.
    render(<Payload<number> query={{ data: 1, isPending: false, error: null } as never} slots={SLOTS}>
      {(n) => <p>drew {n}</p>}
    </Payload>);
    expect(screen.getByText('drew 1')).toBeInTheDocument();
  });

  it('renders the figure and says why, rather than vanishing, when the fetch failed', () => {
    render(<Payload query={failed} slots={SLOTS}>{() => <p>drew</p>}</Payload>);
    // The FIGURE is still there. A page that silently omits a chart looks
    // exactly like a run that recorded nothing for it.
    expect(screen.queryByText('drew')).not.toBeInTheDocument();
    expect(screen.getByText('A chart')).toBeInTheDocument();
  });

  it('distinguishes loading from failed', () => {
    const { unmount } = render(<Payload query={pending} slots={SLOTS}>{() => <p>drew</p>}</Payload>);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    unmount();
    render(<Payload query={failed} slots={SLOTS}>{() => <p>drew</p>}</Payload>);
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });
});

describe('TableSection', () => {
  it('keeps its heading when the fetch failed', () => {
    render(<TableSection title="Errors" query={failed}>{() => <p>rows</p>}</TableSection>);
    expect(screen.getByRole('heading', { name: 'Errors' })).toBeInTheDocument();
    expect(screen.queryByText('rows')).not.toBeInTheDocument();
  });
});
