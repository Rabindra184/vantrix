import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import useReportFilter from '../src/routes/report/useReportFilter';

/**
 * The Report's `?remote=` / `?hostname=` filter (GE's own parameter).
 *
 * A filter is part of the shareable view (AC-DASH-4), so it lives in the URL —
 * written with `replace: true` and keeping every other parameter, the window
 * above all: a reader who picked a remote inside a brushed window must not lose
 * the window. And a value the run does not have is read as "every remote", so
 * a stale or hand-edited link can never send an unknown filter to the API.
 */

afterEach(() => cleanup());

const KNOWN = ['a/1.2.3.4:443', 'b/1.2.3.4:443'] as const;

// `known` is an options field, not a defaulted argument: a JavaScript default
// applies to an explicit `undefined`, which is exactly the case under test.
function mount(entry: string, opts: { readonly known: readonly string[] | undefined } = { known: KNOWN }) {
  const { known } = opts;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
  );
  return renderHook(
    () => ({ filter: useReportFilter('remote', known), location: useLocation(), nav: useNavigationType() }),
    { wrapper },
  );
}

const params = (search: string) => new URLSearchParams(search);

describe('useReportFilter', () => {
  it('reads every remote when the parameter is absent', () => {
    expect(mount('/r').result.current.filter[0]).toBe('*');
  });

  it('reads a value the run has', () => {
    const remote = KNOWN[1];
    expect(mount(`/r?remote=${encodeURIComponent(remote)}`).result.current.filter[0]).toBe(remote);
  });

  it('reads every remote for a value the run does not have', () => {
    expect(mount('/r?remote=nope').result.current.filter[0]).toBe('*');
  });

  it('reads every remote until the run has said which remotes it has', () => {
    // A known value, but nothing to check it against yet: never trusted unchecked.
    expect(mount(`/r?remote=${encodeURIComponent(KNOWN[0])}`, { known: undefined }).result.current.filter[0]).toBe('*');
  });

  it('writes the value, keeps the window, and replaces rather than pushes', () => {
    const { result } = mount('/r?from=1000&to=5000');
    act(() => result.current.filter[1](KNOWN[1]));
    const p = params(result.current.location.search);
    expect(p.get('remote')).toBe(KNOWN[1]);
    expect(p.get('from')).toBe('1000');
    expect(p.get('to')).toBe('5000');
    expect(result.current.nav).toBe('REPLACE');
    expect(result.current.filter[0]).toBe(KNOWN[1]);
  });

  it('deletes the parameter for every remote, keeping the rest', () => {
    const { result } = mount(`/r?from=1000&remote=${encodeURIComponent(KNOWN[0])}&sort=p95`);
    act(() => result.current.filter[1]('*'));
    const p = params(result.current.location.search);
    expect(p.has('remote')).toBe(false);
    expect(p.get('from')).toBe('1000');
    expect(p.get('sort')).toBe('p95');
  });
});
