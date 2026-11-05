import { displayPath } from '@perfportal/contracts';

/**
 * ═══ WHAT A CHART WAS NARROWED TO, AND HOW IT SAYS SO ═══
 * (docs/superpowers/specs/2026-11-04-report-pickers-design.md, section 5)
 *
 * The Report's pickers narrow the Requests section to one group or one request,
 * and Virtual users to one scenario. The charts' TITLES do not change under a
 * pick — the section bar states it — so two things in each chart do:
 *
 *   - an EMPTY chart says where it looked. A chart narrowed to one group that
 *     drew nothing has not shown that the run recorded nothing, so "for this
 *     run" in its sentence is false whenever another group ran. It says "for
 *     this group" instead, and "for this group in the selected window" when a
 *     window is applied too — the scoped-empty rule `agentChart.ts`'s `scopeOf`
 *     already follows for a remote and a hostname.
 *   - a DRAWN chart names the pick behind its ⓘ ("Narrowed to the group
 *     Cart."), ahead of whatever it already said there, so the trigger's
 *     accessible description carries it too.
 *
 * ONLY SENTENCES ABOUT THE DATA MOVE. A sentence about how the run was ingested
 * or stored — the fixed-bands caveat, the overflow note, the data-resolution
 * note — stays, because a pick cannot make it false; the rule the window branch
 * already follows (`CLAUDE.md`, "THE REPORT'S CHARTS NAME THE WINDOW").
 *
 * OPTIONAL on every transform and chart that takes it (ruling R4), as
 * `agentChart.ts`'s `filter` is: the Summary and the drill-downs never narrow.
 * The guard against a chart dropping it is `ChartWindowSelected.test.tsx`,
 * which renders all nine narrowable charts with every kind.
 */

/**
 * The pick a chart was narrowed to, or `null` for none.
 *
 * `name` is the stored identity — a request's joined name, a group's
 * `/`-joined path (`''` is "(no group)", the requests that sit in no group),
 * or a scenario's name. `label`, when present, is shown in place of the name
 * derived from it, so the picker can hand over the label it lists the pick
 * under (a request reads `Catalog / Recommendations / Related Items`, ruling
 * R5). It is ignored for "(no group)", whose wording is fixed below.
 */
export type Narrowed = {
  readonly kind: 'request' | 'group' | 'scenario';
  readonly name: string;
  readonly label?: string;
} | null;

/** What a transform's options carry for these sentences. */
export interface ScopeOpts {
  readonly windowSelected: boolean;
  readonly narrowed?: Narrowed;
}

/**
 * "(no group)" is not a group, so it is never called one: "the group (no
 * group)" reads as a group named "(no group)". The requests in no group are a
 * set of requests, and this one noun phrase names them in both the empty
 * sentence and the ⓘ line, so the two cannot drift into describing them two
 * ways.
 */
const IN_NO_GROUP = 'requests in no group';
const NO_GROUP = `the ${IN_NO_GROUP}`;

function isNoGroup(narrowed: NonNullable<Narrowed>): boolean {
  return narrowed.kind === 'group' && narrowed.name === '';
}

/**
 * Where an empty chart says it looked:
 *
 *   'in this run' | 'in the selected window'
 *   'for this group' | 'for this group in the selected window'
 *   (and 'for this request' / 'for this scenario' in place of 'for this group')
 *   'for the requests in no group'
 *     | 'in the selected window for the requests in no group'
 *
 * THE NO-GROUP PHRASE PUTS THE WINDOW FIRST. Appended, as the others are, it
 * read "for the requests in no group in the selected window", which parses as
 * "no group in the selected window" as readily as the meaning. With the
 * window first, "in no group" ends the phrase and can attach to nothing else.
 *
 * Absent and `null` both mean no pick.
 */
export function scopePhrase(opts: ScopeOpts): string {
  const { windowSelected, narrowed } = opts;
  if (narrowed == null) return windowSelected ? 'in the selected window' : 'in this run';
  if (isNoGroup(narrowed)) return windowSelected ? `in the selected window for ${NO_GROUP}` : `for ${NO_GROUP}`;
  const subject = `this ${narrowed.kind}`;
  return windowSelected ? `for ${subject} in the selected window` : `for ${subject}`;
}

/**
 * The pick as a short NAME — where a chart would otherwise label its data
 * "All requests": the ranges bar's category, and so its tooltip.
 *
 * The name `narrowedLine` shows: `label` when given; a group as the picker
 * lists it (`displayPath`: `Catalog / Recommendations`); a request or
 * scenario by the name it was given, because `displayPath` splits every `/`
 * and a top-level `/login` would read ` / login` (ruling R5). "(no group)" is
 * `Requests in no group`, the line's own noun phrase, and never takes a label
 * (a picker's "(no group)" is not a name).
 */
export function pickLabel(narrowed: NonNullable<Narrowed>): string {
  if (isNoGroup(narrowed)) return `${IN_NO_GROUP.charAt(0).toUpperCase()}${IN_NO_GROUP.slice(1)}`;
  return narrowed.label ?? (narrowed.kind === 'group' ? displayPath(narrowed.name) : narrowed.name);
}

/**
 * The ⓘ line naming the pick — 'Narrowed to the group Cart.' — or `undefined`
 * when nothing was picked. The name is `pickLabel`'s, so the line and a
 * chart's category cannot name one pick two ways.
 */
export function narrowedLine(narrowed: Narrowed | undefined): string | undefined {
  if (narrowed == null) return undefined;
  if (isNoGroup(narrowed)) return `Narrowed to ${NO_GROUP}.`;
  return `Narrowed to the ${narrowed.kind} ${pickLabel(narrowed)}.`;
}

/**
 * A chart's `limitation` with the pick's line in front of it — the pick first,
 * because it changes how every other caveat beside it is read. `undefined`
 * stays `undefined` when nothing was picked, so a chart with no ⓘ grows none.
 */
export function withNarrowedLine(limitation: string | undefined, narrowed: Narrowed | undefined): string | undefined {
  const line = narrowedLine(narrowed);
  if (line === undefined) return limitation;
  return limitation === undefined ? line : `${line} ${limitation}`;
}
