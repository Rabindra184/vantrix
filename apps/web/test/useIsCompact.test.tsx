import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useIsCompact from '../src/useIsCompact';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Probe() {
  return <p data-testid="probe">{String(useIsCompact())}</p>;
}

/** A `matchMedia` whose `matches` this test controls, and whose listener it can fire. */
function stubMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initial,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  const spy = vi.fn(() => query);
  vi.stubGlobal('matchMedia', spy);
  return {
    spy,
    /** Move the viewport across the breakpoint and notify, as a browser would. */
    set(matches: boolean) {
      query.matches = matches;
      act(() => listeners.forEach((fn) => fn()));
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

describe('useIsCompact', () => {
  it('asks for the breakpoint §22.6 names, exclusive of 768', () => {
    // `max-width` is inclusive, and the CSS breakpoint is "from 768 up". A
    // query of `max-width: 768px` would make 768 itself both compact and not.
    const mq = stubMatchMedia(false);
    render(<Probe />);
    expect(mq.spy).toHaveBeenCalledWith('(max-width: 767px)');
  });

  it.each([
    [true, 'true'],
    [false, 'false'],
  ])('reports %s from the query', (matches, expected) => {
    stubMatchMedia(matches);
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent(expected);
  });

  it('follows a rotation across the breakpoint', () => {
    const mq = stubMatchMedia(false);
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('false');

    mq.set(true);
    expect(screen.getByTestId('probe')).toHaveTextContent('true');
  });

  it('unsubscribes on unmount, so a run page navigated away from stops listening', () => {
    const mq = stubMatchMedia(false);
    const view = render(<Probe />);
    expect(mq.listenerCount).toBe(1);

    view.unmount();
    expect(mq.listenerCount).toBe(0);
  });

  it('falls back to NOT compact where matchMedia does not exist', () => {
    // `vitest.config.ts` runs some suites in a node environment, and a
    // server-rendered client cannot measure a viewport before it has one.
    // Rendering the full page is the honest default — it is what every
    // existing test expects, and it withholds nothing.
    vi.stubGlobal('matchMedia', undefined);
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('false');
  });
});
