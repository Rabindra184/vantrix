import { displayPath, innermostGroup, requestsInGroup } from '@perfportal/contracts';
import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { isFragmentInPlace } from '../src/fragmentInPlace';
import ReportFilterControl from '../src/routes/report/ReportFilterControl';
import useRequestsPick, { requestLabel } from '../src/routes/report/useRequestsPick';
import fixture from './fixtures/reference-run.json';

/**
 * The Requests section's Group and Request pick (`?requests-group=`,
 * `?requests-request=`), read from and written to the URL
 * (docs/superpowers/specs/2026-11-04-report-pickers-design.md, section 5).
 *
 * The names come from the reference run's own `/stats` rows — request-scope
 * `response_time` and group-scope `group_cumulated`, which is where Task 8
 * reads them — and every handle below is DERIVED from them, with the shape
 * each case relies on asserted first, so a re-capture that changes the run
 * fails at that precondition and says why rather than at an expectation.
 */

afterEach(() => cleanup());

const ROWS = fixture.stats.stats;
const REQUESTS = ROWS.filter((r) => r.scope === 'request' && r.family === 'response_time').map((r) => r.name);
const GROUPS = ROWS.filter((r) => r.scope === 'group' && r.family === 'group_cumulated').map((r) => r.name);
const NAMES = { requests: REQUESTS, groups: GROUPS } as const;

const members = (group: string, requests: readonly string[] = REQUESTS, groups: readonly string[] = GROUPS) =>
  requestsInGroup(requests, groups, group);

/** A subgroup: a group whose path sits inside another of the run's groups. */
const NESTED = GROUPS.find((g) => GROUPS.some((p) => g.startsWith(`${p}/`)));
/** The group holding it. */
const PARENT = GROUPS.find((p) => NESTED !== undefined && NESTED.startsWith(`${p}/`));
/** A group with two or more requests and no subgroup. */
const FLAT = GROUPS.find((g) => members(g).length >= 2 && !GROUPS.some((o) => o.startsWith(`${g}/`)));
const UNGROUPED = members('');

function shape() {
  if (NESTED === undefined || PARENT === undefined || FLAT === undefined) {
    throw new Error('the reference run must carry a subgroup, its parent, and a flat group of two or more requests');
  }
  const nestedOnly = members(NESTED);
  expect(nestedOnly, 'the subgroup holds exactly one request').toHaveLength(1);
  expect(members(PARENT).length, 'the parent holds more than one request').toBeGreaterThan(1);
  expect(UNGROUPED.length, 'some request sits in no group').toBeGreaterThan(0);
  const flat = members(FLAT);
  const outside = REQUESTS.find((r) => !flat.includes(r));
  if (outside === undefined) throw new Error('some request sits outside the flat group');
  return { nested: NESTED, parent: PARENT, flat: FLAT, deep: nestedOnly[0]!, flatMembers: flat, outside };
}

const enc = encodeURIComponent;
const params = (search: string) => new URLSearchParams(search);

type Names = { readonly requests: readonly string[]; readonly groups: readonly string[] } | undefined;

// `names` is an options field, not a defaulted argument: a JavaScript default
// applies to an explicit `undefined`, which is one of the cases under test.
function mount(entry: string, opts: { readonly names: Names } = { names: NAMES }) {
  const { names } = opts;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
  );
  return renderHook(
    () => ({ pick: useRequestsPick(names), location: useLocation(), nav: useNavigationType() }),
    { wrapper },
  );
}

describe('useRequestsPick', () => {
  it('reads a group and a request from the URL', () => {
    const { flat, flatMembers } = shape();
    const request = flatMembers[1]!;
    const { pick } = mount(`/r?requests-group=${enc(flat)}&requests-request=${enc(request)}`).result.current;
    expect(pick.group).toBe(flat);
    expect(pick.request).toBe(request);
    expect(pick.members).toEqual(flatMembers);
    expect(pick.namedGroup).toBeNull();
    expect(pick.namedRequest).toBeNull();
  });

  it('reads All for both when the URL names neither', () => {
    const { pick } = mount('/r').result.current;
    expect(pick.group).toBe('*');
    expect(pick.request).toBe('*');
    // More than one group to choose from, so nothing to list until one is chosen.
    expect(pick.members).toEqual([]);
  });

  it("takes a request's innermost group when the URL names no group", () => {
    const { nested, parent, deep } = shape();
    const { pick } = mount(`/r?requests-request=${enc(deep)}`).result.current;
    // The subgroup, never its parent, which holds the request too.
    expect(pick.group).toBe(nested);
    expect(pick.group).not.toBe(parent);
    expect(pick.request).toBe(deep);
    expect(pick.namedGroup).toBeNull();
    expect(pick.namedRequest).toBeNull();
  });

  it('takes (no group) for a request that sits in no group', () => {
    shape();
    const { pick } = mount(`/r?requests-request=${enc(UNGROUPED[0]!)}`).result.current;
    expect(pick.group).toBe('');
    expect(pick.request).toBe(UNGROUPED[0]);
    expect(pick.members).toEqual(UNGROUPED);
  });

  it('answers the single member of a one-request group as the request', () => {
    const { nested, deep } = shape();
    const { pick } = mount(`/r?requests-group=${enc(nested)}`).result.current;
    expect(pick.group).toBe(nested);
    expect(pick.request).toBe(deep);
    expect(pick.namedRequest).toBeNull();
  });

  it('reads an unknown group as All and names it', () => {
    const { flat } = shape();
    // A bare prefix of a real group: membership never matches one.
    const unknown = flat.slice(0, -1);
    expect(GROUPS).not.toContain(unknown);
    const { pick } = mount(`/r?requests-group=${enc(unknown)}`).result.current;
    expect(pick.group).toBe('*');
    expect(pick.request).toBe('*');
    expect(pick.members).toEqual([]);
    expect(pick.namedGroup).toEqual({ value: unknown, reason: 'unknown' });
  });

  it('reads a request outside the named group as All and names it', () => {
    const { flat, flatMembers, outside } = shape();
    const { pick } = mount(`/r?requests-group=${enc(flat)}&requests-request=${enc(outside)}`).result.current;
    expect(pick.group).toBe(flat);
    expect(pick.members).toEqual(flatMembers);
    expect(pick.request).toBe('*');
    // Recorded by the run, so `outside` the group, never `unknown`.
    expect(pick.namedRequest).toEqual({ value: outside, reason: 'outside', group: flat, within: flat });
    expect(pick.namedGroup).toBeNull();
  });

  it('reads a request the run does not have as All and names it', () => {
    const { flat } = shape();
    const unknown = `${flat}/nope`;
    expect(REQUESTS).not.toContain(unknown);
    const { pick } = mount(`/r?requests-request=${enc(unknown)}`).result.current;
    expect(pick.group).toBe('*');
    expect(pick.request).toBe('*');
    expect(pick.namedRequest).toEqual({ value: unknown, reason: 'unknown', within: undefined });
  });

  it('answers All while the names are not yet known', () => {
    const { flat, flatMembers } = shape();
    const entry = `/r?requests-group=${enc(flat)}&requests-request=${enc(flatMembers[0]!)}`;
    const { pick } = mount(entry, { names: undefined }).result.current;
    expect(pick.group).toBe('*');
    expect(pick.request).toBe('*');
    expect(pick.members).toEqual([]);
    expect(pick.groups).toEqual([]);
    // Nothing is known to be missing before the run has said what it has.
    expect(pick.namedGroup).toBeNull();
    expect(pick.namedRequest).toBeNull();
  });

  it('offers the groups in payload order, with (no group) last', () => {
    shape();
    // The fixture's groups arrive sorted, so they cannot tell payload order
    // from a sort: the same names, reversed, can.
    const unsorted = [...GROUPS].reverse();
    expect([...unsorted].sort(), 'the list must not already be sorted').not.toEqual(unsorted);
    const names = { requests: REQUESTS, groups: unsorted };
    expect(mount('/r', { names }).result.current.pick.groups).toEqual([...unsorted, '']);
  });

  it('offers only the groups that hold requests', () => {
    // A group whose requests are not in the request list (a warm-up-only
    // request is left out of run_stat) would draw nothing under a pick.
    const { flat, flatMembers } = shape();
    const names = { requests: REQUESTS.filter((r) => !flatMembers.includes(r)), groups: GROUPS };
    expect(mount('/r', { names }).result.current.pick.groups).toEqual([...GROUPS.filter((g) => g !== flat), '']);
  });

  it('reads a memberless group as All and names it', () => {
    const { flat, flatMembers } = shape();
    const names = { requests: REQUESTS.filter((r) => !flatMembers.includes(r)), groups: GROUPS };
    const { pick } = mount(`/r?requests-group=${enc(flat)}`, { names }).result.current;
    expect(pick.group).toBe('*');
    // The run recorded the group: it holds no requests, which is `empty`.
    expect(pick.namedGroup).toEqual({ value: flat, reason: 'empty' });
  });

  it('in a run where every request sits in a group, offers no (no group) and names a link to it', () => {
    shape();
    const grouped = REQUESTS.filter((r) => innermostGroup(r, GROUPS) !== '');
    expect(grouped.length).toBeLessThan(REQUESTS.length);
    const names = { requests: grouped, groups: GROUPS };
    const { pick } = mount('/r?requests-group=', { names }).result.current;
    expect(pick.groups).toEqual(GROUPS);
    expect(pick.groups).not.toContain('');
    expect(pick.group).toBe('*');
    expect(pick.namedGroup).toEqual({ value: '', reason: 'empty' });
  });

  it('in a run with no groups, offers (no group) alone and its requests straight away', () => {
    const names = { requests: REQUESTS, groups: [] };
    const { pick } = mount('/r', { names }).result.current;
    expect(pick.groups).toEqual(['']);
    // Nothing is picked: the one group is the whole run, and narrowing to it
    // would read the run as a merged group for no difference.
    expect(pick.group).toBe('*');
    expect(pick.request).toBe('*');
    expect(pick.members).toEqual(REQUESTS);
  });

  it('in a run with no groups, reads a request without inferring a group, and clears back to the whole run', () => {
    const names = { requests: REQUESTS, groups: [] };
    const request = REQUESTS[1]!;
    const { result } = mount(`/r?requests-request=${enc(request)}`, { names });
    expect(result.current.pick.group).toBe('*');
    expect(result.current.pick.request).toBe(request);
    act(() => result.current.pick.setRequest('*'));
    const p = params(result.current.location.search);
    expect(p.has('requests-request')).toBe(false);
    expect(p.has('requests-group')).toBe(false);
    expect(result.current.pick.group).toBe('*');
  });

  it('in a run with no groups, a link naming a group the run cannot offer holds no request', () => {
    // The Request control is usable here (one offerable group), so the named
    // group must not be read as "no group named": the request beside it is
    // not picked. Nor is it named: the group's place shows the whole run,
    // which the run's request is part of, and the group's note says why.
    const names = { requests: REQUESTS, groups: [] };
    const request = REQUESTS[0]!;
    const { pick } = mount(`/r?requests-group=nope&requests-request=${enc(request)}`, { names }).result.current;
    expect(pick.members).toEqual(REQUESTS);
    expect(pick.group).toBe('*');
    expect(pick.request).toBe('*');
    expect(pick.namedGroup).toEqual({ value: 'nope', reason: 'unknown' });
    expect(pick.namedRequest).toBeNull();
  });

  /*
   * A request beside a group the run cannot offer is judged against the RUN,
   * since All is what that group's place shows: one the run never recorded is
   * `unknown`, one it did record is not named. Never `outside` a group nobody
   * is shown.
   */
  it('beside a group the run never recorded, names a request the run lacks as unknown, never outside', () => {
    const { flat } = shape();
    const unknownGroup = `${flat}x`;
    const unknownRequest = `${flat}/nope`;
    expect(GROUPS).not.toContain(unknownGroup);
    expect(REQUESTS).not.toContain(unknownRequest);
    const { pick } = mount(`/r?requests-group=${enc(unknownGroup)}&requests-request=${enc(unknownRequest)}`).result.current;
    expect(pick.group).toBe('*');
    expect(pick.request).toBe('*');
    expect(pick.namedRequest).toEqual({ value: unknownRequest, reason: 'unknown', within: undefined });
  });

  it('beside a memberless group, names no request the run recorded', () => {
    shape();
    // "(no group)" in a run where every request sits in a group: recorded,
    // and holding nothing.
    const grouped = REQUESTS.filter((r) => innermostGroup(r, GROUPS) !== '');
    const { pick } = mount(`/r?requests-group=&requests-request=${enc(grouped[0]!)}`, {
      names: { requests: grouped, groups: GROUPS },
    }).result.current;
    expect(pick.group).toBe('*');
    expect(pick.request).toBe('*');
    expect(pick.namedGroup).toEqual({ value: '', reason: 'empty' });
    expect(pick.namedRequest).toBeNull();
  });

  it('setRequest drops a group the run cannot offer, so the pick holds', () => {
    const names = { requests: REQUESTS, groups: [] };
    const request = REQUESTS[0]!;
    const { result } = mount('/r?requests-group=nope', { names });
    expect(result.current.pick.namedGroup).toEqual({ value: 'nope', reason: 'unknown' });
    act(() => result.current.pick.setRequest(request));
    const p = params(result.current.location.search);
    expect(p.has('requests-group')).toBe(false);
    expect(p.get('requests-request')).toBe(request);
    expect(result.current.pick.request).toBe(request);
    expect(result.current.pick.namedGroup).toBeNull();
    expect(result.current.pick.namedRequest).toBeNull();
  });

  it('setGroup drops the previous request from the URL', () => {
    const { flat, flatMembers, parent } = shape();
    const entry = `/r?from=1000&to=5000&requests-group=${enc(flat)}&requests-request=${enc(flatMembers[0]!)}&sort=p95`;
    const { result } = mount(entry);
    expect(result.current.pick.request).toBe(flatMembers[0]);
    act(() => result.current.pick.setGroup(parent));
    const p = params(result.current.location.search);
    expect(p.get('requests-group')).toBe(parent);
    expect(p.has('requests-request')).toBe(false);
    expect(p.get('from')).toBe('1000');
    expect(p.get('to')).toBe('5000');
    expect(p.get('sort')).toBe('p95');
    expect(result.current.location.hash).toBe('#requests');
    expect(result.current.nav).toBe('REPLACE');
    expect(isFragmentInPlace(result.current.location.state)).toBe(true);
    expect(result.current.pick.group).toBe(parent);
    expect(result.current.pick.request).toBe('*');
    expect(result.current.pick.namedRequest).toBeNull();
  });

  it("setGroup('') writes requests-group= with an empty value; setGroup('*') deletes it", () => {
    shape();
    const { result } = mount('/r?from=1000');
    act(() => result.current.pick.setGroup(''));
    expect(result.current.location.search).toContain('requests-group=');
    expect(params(result.current.location.search).get('requests-group')).toBe('');
    expect(result.current.pick.group).toBe('');
    expect(result.current.pick.members).toEqual(UNGROUPED);
    act(() => result.current.pick.setGroup('*'));
    const p = params(result.current.location.search);
    expect(p.has('requests-group')).toBe(false);
    expect(p.get('from')).toBe('1000');
    expect(result.current.pick.group).toBe('*');
  });

  it('setRequest writes the request with the same rules, and setRequest("*") deletes it', () => {
    const { flat, flatMembers } = shape();
    const { result } = mount(`/r?to=5000&requests-group=${enc(flat)}`);
    act(() => result.current.pick.setRequest(flatMembers[1]!));
    let p = params(result.current.location.search);
    expect(p.get('requests-request')).toBe(flatMembers[1]);
    expect(p.get('requests-group')).toBe(flat);
    expect(p.get('to')).toBe('5000');
    expect(result.current.location.hash).toBe('#requests');
    expect(result.current.nav).toBe('REPLACE');
    expect(isFragmentInPlace(result.current.location.state)).toBe(true);
    expect(result.current.pick.request).toBe(flatMembers[1]);
    act(() => result.current.pick.setRequest('*'));
    p = params(result.current.location.search);
    expect(p.has('requests-request')).toBe(false);
    expect(p.get('requests-group')).toBe(flat);
    expect(result.current.pick.request).toBe('*');
  });

  it('setRequest keeps the group the reader was shown when the link named only the request', () => {
    const { flat, flatMembers } = shape();
    const { result } = mount(`/r?requests-request=${enc(flatMembers[0]!)}`);
    expect(result.current.pick.group).toBe(flat);
    act(() => result.current.pick.setRequest('*'));
    const p = params(result.current.location.search);
    // Clearing the request leaves the reader in the group the Group control
    // showed, rather than flipping that control back to All groups.
    expect(p.get('requests-group')).toBe(flat);
    expect(p.has('requests-request')).toBe(false);
    expect(result.current.pick.group).toBe(flat);
    expect(result.current.pick.members).toEqual(flatMembers);
  });
});

describe('requestLabel', () => {
  // Inputs written here, not the fixture's: a slash-led top-level request
  // and a slash inside a request's own name are what the rule is about.
  const groups = ['Cart', 'Catalog', 'Catalog/Recommendations'];

  it('reads a request in no group as its own name, a leading slash included', () => {
    expect(requestLabel('/login', groups)).toBe('/login');
    expect(requestLabel('/order/1005', groups)).toBe('/order/1005');
  });

  it("puts ' / ' between the group's segments and the request, and nowhere inside the request's own name", () => {
    expect(requestLabel('Cart/Add To Cart', groups)).toBe('Cart / Add To Cart');
    expect(requestLabel('Catalog/Recommendations/Related Items', groups)).toBe('Catalog / Recommendations / Related Items');
    expect(requestLabel('Cart/order/1005', groups)).toBe('Cart / order/1005');
  });

  it('never reads a bare prefix of a name as its group', () => {
    // `Cartography/x` beside a group `Cart` is in no group: membership is
    // `Cart` and a `/`, never `Cart` alone.
    expect(requestLabel('Cartography/x', ['Cart'])).toBe('Cartography/x');
  });
});

/**
 * ═══ THE NOTE BESIDE A PICK SAYS WHY, AND WHAT IS SHOWN INSTEAD (ruling R12) ═══
 *
 * The hook names a link's value for more than one reason, and the control's
 * line has to say the true one. Each case renders the two controls the way the
 * Requests section does and asserts the CLAIM as an exclusive pair — the true
 * reason present, the false one absent ("never" wherever the run recorded the
 * value) — plus what the line says is shown in its place. Never the sentence
 * verbatim: the words stay rewritable, the claims may not.
 */
function Pickers({ names }: { readonly names: { readonly requests: readonly string[]; readonly groups: readonly string[] } }) {
  const pick = useRequestsPick(names);
  return (
    <>
      <div data-testid="group-picker">
        <ReportFilterControl
          label="Group"
          allLabel="All groups"
          values={pick.groups}
          value={pick.group}
          onChange={pick.setGroup}
          named={pick.namedGroup}
          verb="recorded"
          labelOf={displayPath}
        />
      </div>
      <div data-testid="request-picker">
        <ReportFilterControl
          label="Request"
          allLabel="All requests"
          values={pick.members}
          value={pick.request}
          onChange={pick.setRequest}
          named={pick.namedRequest}
          verb="recorded"
          labelOf={(r) => requestLabel(r, names.groups)}
        />
      </div>
    </>
  );
}

function notes(entry: string, names: { readonly requests: readonly string[]; readonly groups: readonly string[] } = NAMES) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Pickers names={names} />
    </MemoryRouter>,
  );
  const note = (id: string) => within(screen.getByTestId(id)).queryByTestId('filter-unknown')?.textContent ?? null;
  return { group: note('group-picker'), request: note('request-picker') };
}

describe('the note beside a pick', () => {
  it('a request the run recorded, outside the picked group: "not in" that group, never "never", showing the group\'s requests', () => {
    const { flat, outside } = shape();
    expect(REQUESTS).toContain(outside);
    const { request, group } = notes(`/r?requests-group=${enc(flat)}&requests-request=${enc(outside)}`);
    if (request === null) throw new Error('the request note is missing');
    expect(request).toContain(requestLabel(outside, GROUPS));
    expect(request).toMatch(new RegExp(`not in ${displayPath(flat)}`));
    expect(request).not.toMatch(/never/);
    // What is shown in its place is the group's requests, not every request.
    expect(request).toMatch(new RegExp(`showing .*in ${displayPath(flat)}`));
    expect(group).toBeNull();
  });

  it('a request outside a one-request group: "not in" that group, never "never", showing that group\'s one request', () => {
    const { nested, deep, outside } = shape();
    expect(members(nested)).not.toContain(outside);
    const { request } = notes(`/r?requests-group=${enc(nested)}&requests-request=${enc(outside)}`);
    if (request === null) throw new Error('the request note is missing');
    expect(request).toMatch(new RegExp(`not in ${displayPath(nested)}`));
    expect(request).not.toMatch(/never/);
    // The one request is what is shown — the read-only field names it — so
    // "showing all requests" would be false.
    expect(request).toMatch(new RegExp(`showing ${requestLabel(deep, GROUPS)}`));
    expect(request).not.toMatch(/showing all/);
  });

  it('a grouped request beside (no group): not one of the requests in no group, never "never", never "not in (no group)"', () => {
    const { flatMembers } = shape();
    const { request } = notes(`/r?requests-group=&requests-request=${enc(flatMembers[0]!)}`);
    if (request === null) throw new Error('the request note is missing');
    expect(request).toMatch(/not one of the requests in no group/);
    expect(request).not.toMatch(/never/);
    // "(no group)" is a set of requests, not a group (ruling R9).
    expect(request).not.toContain(`not in ${displayPath('')}`);
    expect(request).toMatch(/showing the requests in no group/);
  });

  it('a request the run never recorded: "never", not "not in", showing the picked group\'s requests', () => {
    const { flat } = shape();
    const unknown = `${flat}/nope`;
    expect(REQUESTS).not.toContain(unknown);
    const { request } = notes(`/r?requests-group=${enc(flat)}&requests-request=${enc(unknown)}`);
    if (request === null) throw new Error('the request note is missing');
    expect(request).toMatch(/never recorded/);
    expect(request).not.toMatch(/not in/);
    expect(request).toMatch(new RegExp(`showing .*in ${displayPath(flat)}`));
  });

  it('a request the run recorded beside a group it never recorded: no request note, the group "never"', () => {
    const { flat, flatMembers } = shape();
    const unknownGroup = `${flat}x`;
    expect(GROUPS).not.toContain(unknownGroup);
    expect(REQUESTS).toContain(flatMembers[0]);
    const { request, group } = notes(`/r?requests-group=${enc(unknownGroup)}&requests-request=${enc(flatMembers[0]!)}`);
    if (group === null) throw new Error('the group note is missing');
    // The group's place shows the whole run, which holds this request: there is
    // nothing true to say of it but what the group's note already says.
    expect(request).toBeNull();
    expect(group).toMatch(/never recorded/);
    expect(group).toMatch(/showing all groups/);
  });

  it('a request the run never recorded beside a group it never recorded: "never", not "not in"', () => {
    const { flat } = shape();
    const unknownGroup = `${flat}x`;
    const unknownRequest = `${flat}/nope`;
    expect(GROUPS).not.toContain(unknownGroup);
    expect(REQUESTS).not.toContain(unknownRequest);
    const { request, group } = notes(`/r?requests-group=${enc(unknownGroup)}&requests-request=${enc(unknownRequest)}`);
    if (request === null || group === null) throw new Error('both notes must show');
    expect(request).toMatch(/never recorded/);
    expect(request).not.toMatch(/not in/);
    expect(request).toMatch(/showing all requests/);
    expect(group).toMatch(/never recorded/);
  });

  it('in a run with no groups, a group the run never recorded: "showing the requests in no group", never "all groups"', () => {
    const names = { requests: REQUESTS, groups: [] };
    const { group, request } = notes('/r?requests-group=nope', names);
    if (group === null) throw new Error('the group note is missing');
    // The Group field reads "(no group)", alone: that is what is shown, and
    // the run has no groups for "all groups" to mean.
    expect(group).toMatch(/never recorded/);
    expect(group).toMatch(/showing the requests in no group\./);
    expect(group).not.toMatch(/all groups/);
    expect(request).toBeNull();
  });

  it('a group the run never recorded: "never", not "holds no requests"', () => {
    const { flat } = shape();
    const unknownGroup = `${flat}x`;
    const { group } = notes(`/r?requests-group=${enc(unknownGroup)}`);
    if (group === null) throw new Error('the group note is missing');
    expect(group).toMatch(/never recorded/);
    expect(group).not.toMatch(/holds no requests/);
    expect(group).toMatch(/showing all groups/);
  });

  it('a group the run recorded that holds no requests: "holds no requests", never "never"', () => {
    const { flat, flatMembers } = shape();
    expect(GROUPS).toContain(flat);
    const names = { requests: REQUESTS.filter((r) => !flatMembers.includes(r)), groups: GROUPS };
    const { group } = notes(`/r?requests-group=${enc(flat)}`, names);
    if (group === null) throw new Error('the group note is missing');
    expect(group).toContain(displayPath(flat));
    expect(group).toMatch(/holds no requests/);
    expect(group).not.toMatch(/never/);
  });

  it('(no group) in a run where every request sits in a group: "holds no requests", never "never"', () => {
    shape();
    const names = { requests: REQUESTS.filter((r) => innermostGroup(r, GROUPS) !== ''), groups: GROUPS };
    const { group } = notes('/r?requests-group=', names);
    if (group === null) throw new Error('the group note is missing');
    expect(group).toContain(displayPath(''));
    expect(group).toMatch(/holds no requests/);
    expect(group).not.toMatch(/never/);
  });
});
