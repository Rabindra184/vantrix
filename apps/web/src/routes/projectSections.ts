import type { AccessAction } from '@perfportal/contracts';
import type { ProjectAccess } from '../access/useAccess';
import {
  projectAccessPath,
  projectMembersPath,
  projectNewRunnerRunPath,
  projectPackagesPath,
  projectPath,
  projectRulesPath,
  projectRunsPath,
  projectSetupPath,
} from './paths';

/**
 * A project's sections, as `ProjectShell` draws them in its strip and the
 * command palette offers them as pages — the table, its filter and the launch
 * action beside it, with no component in this module.
 *
 * ═══ WHY THIS IS NOT IN `ProjectShell.tsx` ═══
 *
 * The palette is mounted by the header on every authenticated page, so it is
 * in the entry chunk; `ProjectShell` is drawn only by the project pages, which
 * are loaded lazily. While the palette read this table out of
 * `ProjectShell.tsx`, the bundler had to bring that whole module, component
 * and all, into the entry chunk for seven rows and a filter (measured on the
 * build: the shell's own "Project sections" label sat in `index-*.js`). Here
 * the table costs the entry chunk what it is: data and a function. Its only
 * run-time import is `paths.ts`; the two type imports are erased before the
 * bundler sees them. `paletteDestinations.test.ts` reads both files' imports
 * and fails the day that stops being true.
 *
 * ═══ WHICH SECTIONS A READER IS OFFERED FOLLOWS THEIR ROLE ═══
 *
 * Two sections exist to take an action — Add results to upload a run, API
 * tokens to manage credentials — and so does the launch. Each carries the
 * action it needs (`requires`), and is offered only when the reader's
 * `ProjectAccess` says they may take it: a link to a page whose one action the
 * API would refuse is an offer the reader cannot accept. The API refuses
 * either way; hiding is for clarity. The other five are places every role may
 * read — Members included, since `members:read` asks only for Viewer — so they
 * are offered whatever the answer, which also means they need not wait for
 * one.
 *
 * One table and one filter, read by the strip and the palette alike, so the
 * palette can never offer a tab the strip hides.
 */
export type ProjectSection = 'tests' | 'runs' | 'packages' | 'setup' | 'rules' | 'members' | 'access';

/** One tab of the strip: where it goes, what it is called, and what a reader needs to be offered it. */
export interface Section {
  readonly section: ProjectSection;
  readonly label: string;
  readonly path: (slug: string) => string;
  /** The action the section's page exists to take; absent for a section every role may read. */
  readonly requires?: AccessAction;
}

export const SECTIONS: readonly Section[] = [
  /* Tests first because `/projects/:slug` is the project's own page and a
     project's tests are the rung directly below it — `Organization → Project
     → Test → Run`. Runs second because it is the same data one rung flatter.
     Then the configuration sections, in the order a project is set up: what
     you run, how results get in, what judges them, who works on it, and the
     credential the second of those needs. Packages come first of them
     because a package is the thing a run is made FROM, which is the nearest
     neighbour of "what ran here" — and an upload under Add results becomes
     one either way. */
  { section: 'tests', label: 'Tests', path: projectPath },
  { section: 'runs', label: 'Runs', path: projectRunsPath },
  { section: 'packages', label: 'Packages', path: projectPackagesPath },
  { section: 'setup', label: 'Add results', path: projectSetupPath, requires: 'run:upload' },
  { section: 'rules', label: 'SLA rules', path: projectRulesPath },
  { section: 'members', label: 'Members', path: projectMembersPath },
  /* "API tokens", matching the page's own content (review 09-13 M18). A tab
     and the page it opens must not disagree about what the page is — and
     "Access" promised members and roles, which are the section above. */
  { section: 'access', label: 'API tokens', path: projectAccessPath, requires: 'tokens:manage' },
];

/**
 * The sections `access` allows, in the strip's order: every section that
 * requires nothing, and each gated one only when `access.can` says yes — which
 * it never does before access is known.
 *
 * The shell draws its strip with this, and the command palette offers a
 * project's pages with it, so the two answer the same question the same way.
 */
export function visibleSections(access: ProjectAccess): readonly Section[] {
  return SECTIONS.filter((s) => s.requires === undefined || access.can(s.requires));
}

/**
 * The launch action beside the shell's heading — and the palette's last page
 * for a project — with the action it needs: the form starts a run on the
 * on-prem runner, which `runner:run` guards.
 */
export const LAUNCH: Readonly<{ label: string; path: (slug: string) => string; requires: AccessAction }> = {
  label: 'New on-prem run',
  path: (slug) => projectNewRunnerRunPath(slug),
  requires: 'runner:run',
};
