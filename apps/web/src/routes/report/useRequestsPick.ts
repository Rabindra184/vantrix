import { displayPath, innermostGroup, requestsInGroup } from '@perfportal/contracts';
import { useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useSectionParams } from './useReportFilter';

/**
 * ═══ THE REQUESTS SECTION'S GROUP AND REQUEST PICK, IN THE URL ═══
 * (docs/superpowers/specs/2026-11-04-report-pickers-design.md, section 5)
 *
 * Gatling Enterprise's per-section spelling: `?requests-group=Cart` and
 * `?requests-request=Cart%2FAdd%20To%20Cart`. `requests-group=` with an EMPTY
 * value is "(no group)", the requests that sit in no group; an absent key is
 * "All". The values are the stored identities — a group's `/`-joined path, a
 * request's joined name — and membership is `requestsInGroup`, the rule the
 * API merges a group's series by, so the picker and the server cannot
 * disagree about which requests a group means.
 *
 * Every write follows `useReportFilter`'s rules through `useSectionParams`:
 * `replace: true`, every other parameter kept (the window above all), the
 * section's `#requests` carried and marked `FRAGMENT_IN_PLACE`. It is
 * `URLSearchParams` that serialises, so a space is written `+`, not `%20`:
 * the two read back identically, and a check on the URL should parse it
 * rather than compare the string.
 *
 * KNOWN LIMIT, shared with `useReportFilter`: `'*'` is the All sentinel, so a
 * group or request literally named `*` cannot be picked.
 *
 * ═══ WHAT A LINK ASKS FOR IS CHECKED AGAINST THE RUN'S OWN NAMES ═══
 *
 * `names` is the section's own `/stats` rows (request-scope `response_time`
 * and group-scope `group_cumulated`). Until it has answered (`undefined`)
 * nothing is checked, so the answer is All for both and nothing is named —
 * and the caller fires no figure read until then (Review Focus 3).
 *
 *   - A group is OFFERED only when it holds requests (ruling R10a). A group
 *     with none, "(no group)" in a run where every request sits in a group
 *     included, would answer a group `/distribution` with a 404, which the
 *     client reads as "this server cannot narrow by group" — a false claim
 *     about the server, reached through the picker. So a URL naming a
 *     memberless group reads exactly as an unknown one: All, and named.
 *   - A request named WITHOUT a group takes its innermost group from its name
 *     (`(no group)` when it has none) — while the Group control offers a
 *     choice. With one offerable group (a run with no groups, or one where
 *     every request is in the same group) that control is a read-only field,
 *     the whole run IS that group, and inferring it would turn every request
 *     pick into a group pick nobody made.
 *   - A request named WITH a group must be one of that group's requests; one
 *     outside it, or one the run does not have, reads as All and is named. A
 *     group that is unknown or memberless holds nothing, so a request beside
 *     it reads as All too.
 *   - A group with exactly one request answers that request, with nothing
 *     written: "a group with one request selects it", and the Request
 *     control is then a read-only field naming it.
 *
 * ═══ CHANGING THE GROUP DROPS THE REQUEST (Review Focus 4) ═══
 *
 * `setGroup` deletes `requests-request` in the same navigation. Left behind,
 * a request from the previous group would sit in the URL under a group that
 * does not hold it, read as All and named — a "this link named…" line the
 * reader's own click had caused.
 */
export interface RequestsPick {
  /** `'*'` is All groups; `''` is "(no group)"; else a group's path. */
  readonly group: string;
  /** `'*'` is All requests, or none picked; else a request's joined name. */
  readonly request: string;
  /**
   * What the Request control lists: the picked group's requests, in payload
   * order. With no group picked, the one offerable group's requests when there
   * is only one (its Group control is read-only, so the Request control is
   * usable straight away), and `[]` otherwise — the Request control is then
   * disabled with "Pick a group first.".
   */
  readonly members: readonly string[];
  /** The groups the Group control offers: payload order, `''` last and only
   *  when it holds requests. `[]` until the names are known. */
  readonly groups: readonly string[];
  /** Writes the group (`'*'` deletes it) and deletes any request. */
  readonly setGroup: (next: string) => void;
  /** Writes the request (`'*'` deletes it), with the group the reader was shown. */
  readonly setRequest: (next: string) => void;
  /** A group the URL asked for that this run cannot offer, or null. */
  readonly namedGroup: string | null;
  /** A request the URL asked for that this run, or the named group, lacks; or null. */
  readonly namedRequest: string | null;
}

export type RequestsNames = { readonly requests: readonly string[]; readonly groups: readonly string[] };

const GROUP = 'requests-group';
const REQUEST = 'requests-request';
const SECTION = 'requests';

interface Resolved {
  readonly group: string;
  readonly request: string;
  readonly members: readonly string[];
  readonly groups: readonly string[];
  readonly namedGroup: string | null;
  readonly namedRequest: string | null;
}

const NOTHING_KNOWN: Resolved = { group: '*', request: '*', members: [], groups: [], namedGroup: null, namedRequest: null };

function resolve(names: RequestsNames | undefined, rawGroup: string | null, rawRequest: string | null): Resolved {
  if (names === undefined) return NOTHING_KNOWN;
  const { requests, groups: groupNames } = names;
  const holds = (g: string) => requestsInGroup(requests, groupNames, g);

  const groups = groupNames.filter((g) => holds(g).length > 0);
  if (holds('').length > 0) groups.push('');
  const choice = groups.length > 1;

  let group = '*';
  if (rawGroup !== null) {
    if (groups.includes(rawGroup)) group = rawGroup;
  } else if (choice && rawRequest !== null && requests.includes(rawRequest)) {
    group = innermostGroup(rawRequest, groupNames);
  }

  const members = group !== '*' ? holds(group) : groups.length === 1 ? holds(groups[0]!) : [];
  // A named group that cannot be offered holds nothing, so neither does a
  // request beside it.
  const pool = rawGroup !== null && group === '*' ? [] : members;

  let request = rawRequest !== null && pool.includes(rawRequest) ? rawRequest : '*';
  if (request === '*' && group !== '*' && members.length === 1) request = members[0]!;

  return {
    group,
    request,
    members,
    groups,
    namedGroup: rawGroup !== null && !groups.includes(rawGroup) ? rawGroup : null,
    namedRequest: rawRequest !== null && request !== rawRequest ? rawRequest : null,
  };
}

export default function useRequestsPick(names: RequestsNames | undefined): RequestsPick {
  const { search } = useLocation();
  const url = new URLSearchParams(search);
  const rawGroup = url.get(GROUP);
  const rawRequest = url.get(REQUEST);
  const resolved = useMemo(() => resolve(names, rawGroup, rawRequest), [names, rawGroup, rawRequest]);

  const write = useSectionParams(SECTION);
  const setGroup = useCallback(
    (next: string) =>
      write((p) => {
        if (next === '*') p.delete(GROUP);
        else p.set(GROUP, next);
        p.delete(REQUEST);
      }),
    [write],
  );

  const shownGroup = resolved.group;
  const setRequest = useCallback(
    (next: string) =>
      write((p) => {
        // The group goes with it as the reader was shown it: a group inferred
        // from a request-only link is written out, so clearing the request
        // leaves the Group control where it was rather than flipping it back
        // to All groups; and a group the run cannot offer is dropped, so the
        // pick is not read as "outside the named group" the moment it lands.
        if (shownGroup === '*') p.delete(GROUP);
        else p.set(GROUP, shownGroup);
        if (next === '*') p.delete(REQUEST);
        else p.set(REQUEST, next);
      }),
    [write, shownGroup],
  );

  return { ...resolved, setGroup, setRequest };
}

/**
 * A request as a reader reads it (ruling R5): its innermost group's path, then
 * ` / `, then the request's own name — `Catalog / Recommendations / Related
 * Items` — and the raw name for a request in no group.
 *
 * Not `displayPath` over the whole name: that splits on EVERY `/`, so a
 * slash-led top-level request (`/login`) would read ` / login`, and a slash
 * inside a request's own name (`Cart/order/1005`, a request `order/1005` in
 * `Cart`) would read as a group that does not exist. `displayPath` is for a
 * GROUP's path; the request's own name is shown as it was recorded.
 *
 * One definition, for the Request picker's options and for a chart's
 * `narrowed.label`, so the two never name one request two ways.
 */
export function requestLabel(name: string, groupNames: readonly string[]): string {
  const group = innermostGroup(name, groupNames);
  return group === '' ? name : `${displayPath(group)} / ${name.slice(group.length + 1)}`;
}
