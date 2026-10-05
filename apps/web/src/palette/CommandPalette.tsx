import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OrgTestSummary, RunStatus, RunVerdict } from '@perfportal/contracts';
import { formatListInstant } from '../routes/format';
import { Marked, STATUS, VERDICT, type Mark } from '../routes/marks';
import { projectPath, projectTestPath, runPath } from '../routes/paths';
import { runName } from '../runNumber';
import type { Destination, ProjectRef } from './destinations';
import {
  usePaletteSearch,
  type PaletteGroups,
  type RunByNumberHit,
  type RunRow,
} from './usePaletteSearch';

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * ═══ THE ⌘K PALETTE: ONE INPUT, FIVE SEARCHES, ONE LIST ═══
 * (docs/superpowers/specs/2026-10-05-portfolio-home-and-command-palette-design.md)
 *
 * A Radix Dialog holding a `cmdk` command menu. `cmdk` supplies the combobox,
 * the listbox and its options, arrow keys, Home/End and Enter — the parts this
 * repo has paid for hand-building before — and `shouldFilter={false}` turns
 * its own matching off, because the matching here is the server's (tests,
 * runs) or `destinations.ts`'s (projects, pages) and a second, fuzzy opinion
 * layered on top would hide rows the search deliberately returned.
 *
 * What it shows is `usePaletteSearch`'s; this file only draws it, and every
 * decision about WHICH request runs, and when, is made there.
 */
export default function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  /* Where focus was before the palette took it. Radix's modal content hands
     focus back to its own `Dialog.Trigger` on close — and this dialog has
     none: it is opened by a header button and a keyboard shortcut that live
     elsewhere. Without this, closing drops focus on <body>. */
  const returnFocusTo = useRef<HTMLElement | null>(null);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          // The title names the dialog; there is no separate description, and
          // saying so explicitly is what silences Radix's dev warning.
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            const active = document.activeElement;
            returnFocusTo.current = active instanceof HTMLElement ? active : null;
          }}
          onCloseAutoFocus={(event) => {
            const target = returnFocusTo.current;
            returnFocusTo.current = null;
            /* Only an element still in the document: choosing a result can
               navigate away from the page that held it. */
            if (target !== null && target.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
          /* Centred with explicit offsets — Tailwind's preflight resets the
             `margin: auto` a browser would otherwise centre with — and never
             wider than the screen less a gutter, so a long name can only
             truncate inside it, never push the page sideways. */
          className="fixed top-[15vh] left-1/2 z-50 w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-default bg-surface text-primary shadow-panel"
        >
          <Dialog.Title className="sr-only">Search PerfPortal</Dialog.Title>
          {/* Its own component so that closing UNMOUNTS it: the typed text,
              the debounce and every search reset together, and a reopened
              palette starts at "Go to" rather than at the last query. */}
          <PaletteSearch
            onChoose={(to) => {
              navigate(to);
              onOpenChange(false);
            }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* Each row's cmdk `value`, one function per kind so the list below and the
   rows it renders cannot spell one differently. Unique across the whole list:
   cmdk treats two items sharing a value as one, so a duplicate is a row that
   silently cannot be reached. A destination's own id is already unique. */
const projectValue = (p: ProjectRef) => `project:${p.slug}`;
const testValue = (t: OrgTestSummary) => `test:${t.id}`;
const runValue = (r: RunRow) => `run:${r.id}`;
const runNumberValue = (h: RunByNumberHit) => `num:${h.run.id}`;

/** Every row's value, in the order the rows are drawn. */
function rowValues(groups: PaletteGroups): string[] {
  return [
    ...groups.goTo.map((d) => d.id),
    ...groups.projects.items.map(projectValue),
    ...groups.pages.items.map((d) => d.id),
    ...groups.tests.items.map(testValue),
    ...groups.runs.items.map(runValue),
    ...groups.runByNumber.items.map(runNumberValue),
  ];
}

function PaletteSearch({ onChoose }: { readonly onChoose: (to: string) => void }) {
  const [raw, setRaw] = useState('');
  const groups = usePaletteSearch(raw);
  const announcement = useResultAnnouncement(groups);

  /* ═══ THE HIGHLIGHT IS HELD HERE, BECAUSE cmdk LOSES IT ═══

     cmdk keeps the highlighted row's value and, when that row unmounts, is
     meant to move the highlight to the first row left. It schedules that
     check under ONE key per batch, so when several rows unmount in the same
     commit — the whole "Go to" list as the first search lands, or five
     results replaced by five others — only the LAST row's check survives,
     and unless that happens to be the highlighted one the value goes on
     naming a row that no longer exists. Nothing is then highlighted and
     Enter does nothing, on exactly the keystroke a reader makes most.

     So the value is controlled, and a value no longer on screen is handed
     back as '' — cmdk reads an empty value as "nothing chosen" and picks the
     first row itself as the new rows mount, through the same path that keeps
     the input's `aria-activedescendant` in step. */
  const [highlighted, setHighlighted] = useState('');
  const value = rowValues(groups).includes(highlighted) ? highlighted : '';

  return (
    /* `vimBindings` off: cmdk otherwise moves the highlight on Ctrl+K, and
       Ctrl+K is this palette's own shortcut to close. */
    <Command
      shouldFilter={false}
      label="Search PerfPortal"
      vimBindings={false}
      value={value}
      onValueChange={setHighlighted}
    >
      <Command.Input
        value={raw}
        onValueChange={setRaw}
        placeholder="Search projects, tests and runs"
        className="h-12 w-full border-b border-default bg-transparent px-4 text-[0.9375rem] text-primary outline-none placeholder:text-faint"
      />
      <Command.List
        label="Results"
        className="max-h-[min(60vh,26rem)] overflow-x-hidden overflow-y-auto p-1.5"
      >
        {groups.goTo.length > 0 && (
          <PaletteGroup heading="Go to">
            {groups.goTo.map((d) => (
              <DestinationRow key={d.id} destination={d} onChoose={onChoose} />
            ))}
          </PaletteGroup>
        )}
        {groups.projects.items.length > 0 && (
          <PaletteGroup heading="Projects">
            {groups.projects.items.map((p) => (
              <Row key={p.slug} value={projectValue(p)} to={projectPath(p.slug)} onChoose={onChoose}>
                <Primary>{p.name}</Primary> <Secondary>{p.slug}</Secondary>
              </Row>
            ))}
          </PaletteGroup>
        )}
        {groups.pages.items.length > 0 && (
          <PaletteGroup heading="Pages">
            {groups.pages.items.map((d) => (
              <DestinationRow key={d.id} destination={d} onChoose={onChoose} />
            ))}
          </PaletteGroup>
        )}
        {groups.tests.items.length > 0 && (
          <PaletteGroup heading="Tests">
            {groups.tests.items.map((t) => (
              <TestRow key={t.id} test={t} onChoose={onChoose} />
            ))}
          </PaletteGroup>
        )}
        {groups.runs.items.length > 0 && (
          <PaletteGroup heading="Runs">
            {groups.runs.items.map((r) => (
              <RunResultRow key={r.id} run={r} onChoose={onChoose} />
            ))}
          </PaletteGroup>
        )}
        {groups.runByNumber.items.length > 0 && (
          <PaletteGroup heading="Run by number">
            {groups.runByNumber.items.map((hit) => (
              <Row
                key={hit.run.id}
                value={runNumberValue(hit)}
                to={runPath(hit.run.id)}
                onChoose={onChoose}
              >
                <Primary>{`${runLabel(hit.run)} · ${hit.test.name} · ${hit.test.project.name}`}</Primary>
              </Row>
            ))}
          </PaletteGroup>
        )}
      </Command.List>

      {/* Outside the listbox, so they are read as text rather than skipped as
          non-options, and below it, so a failure stays in view however long
          the list above has grown. One quiet line per failed group, in the
          groups' own order. */}
      <PaletteNotes groups={groups} />

      {announcement !== null && (
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
      )}
    </Command>
  );
}

/**
 * The count a screen reader hears, or null when there is none to say.
 *
 * Null with nothing typed — "Go to" is not a search result — and null until a
 * typed query has SETTLED for the first time, so the region is never present
 * holding a half-counted number. Once it has a count it KEEPS the last settled
 * one while the next query loads (the rows on screen are still that answer's,
 * by `keepPreviousData`), and changes only when the next answer is complete.
 * A live region that disappeared on every keystroke would be inserted afresh
 * each time, and an inserted region is not a changed one.
 */
function useResultAnnouncement(groups: PaletteGroups): string | null {
  const [last, setLast] = useState<string | null>(null);
  const current =
    groups.query.text === ''
      ? null
      : groups.settled
        ? `${groups.total} ${groups.total === 1 ? 'result' : 'results'}`
        : undefined;
  // Adjusting state during render, React's pattern for state derived from
  // props: one render, no effect committing a stale count first.
  if (current !== undefined && current !== last) setLast(current);
  return current === undefined ? last : current;
}

function PaletteNotes({ groups }: { readonly groups: PaletteGroups }) {
  const failures: string[] = [];
  if (groups.projects.status === 'error') failures.push("Couldn't load projects");
  if (groups.tests.status === 'error') failures.push("Couldn't search tests");
  if (groups.runs.status === 'error') failures.push("Couldn't search runs");
  if (groups.runByNumber.status === 'error') failures.push("Couldn't look up that run");
  const empty = groups.settled && groups.total === 0 && groups.query.text !== '';
  if (failures.length === 0 && !empty) return null;

  return (
    <div className="border-t border-default px-4 py-2.5 text-[0.8125rem] text-muted">
      {failures.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {empty && <p className="min-w-0 truncate">{`No results for “${groups.query.text}”`}</p>}
    </div>
  );
}

function PaletteGroup({ heading, children }: { readonly heading: string; readonly children: ReactNode }) {
  return (
    <Command.Group
      heading={
        <span className="block px-2 pt-2 pb-1 text-[0.6875rem] tracking-wide text-faint uppercase">
          {heading}
        </span>
      }
    >
      {children}
    </Command.Group>
  );
}

/** One option. Its `value` (see `rowValues`) identifies it and is never shown. */
function Row({
  value,
  to,
  onChoose,
  children,
}: {
  readonly value: string;
  readonly to: string;
  readonly onChoose: (to: string) => void;
  readonly children: ReactNode;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={() => onChoose(to)}
      className="flex max-w-full min-w-0 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[0.8125rem] select-none data-[selected=true]:bg-sunken"
    >
      {children}
    </Command.Item>
  );
}

/* A row's parts. Each truncates on its own and none can widen the row; the
   spaces between them are real text nodes, because a flex gap moves pixels and
   a screen reader reads text (CLAUDE.md, "A MARGIN IS NOT A SPACE"). */
function Primary({ children }: { readonly children: ReactNode }) {
  return <span className="min-w-0 max-w-full truncate">{children}</span>;
}

function Secondary({ children }: { readonly children: ReactNode }) {
  return <span className="min-w-0 max-w-[50%] shrink-[2] truncate text-muted">{children}</span>;
}

function Outcome({ mark }: { readonly mark: Mark }) {
  return (
    <span className="ml-auto shrink-0 text-[0.75rem]">
      <Marked mark={mark} />
    </span>
  );
}

function DestinationRow({
  destination,
  onChoose,
}: {
  readonly destination: Destination;
  readonly onChoose: (to: string) => void;
}) {
  return (
    <Row value={destination.id} to={destination.to} onChoose={onChoose}>
      <Primary>{destination.label}</Primary>
    </Row>
  );
}

/**
 * One mark for a run's outcome, as the run list's two badges would read in
 * one: a finished run's VERDICT is the news, an unfinished one's STATE is.
 * `STATUS` and `VERDICT` are `marks.tsx`'s, so a glyph or a word changed there
 * changes here too.
 */
function outcomeMark(status: RunStatus, verdict: RunVerdict | null): Mark {
  return status === 'complete' ? VERDICT[verdict ?? 'none'] : STATUS[status];
}

function TestRow({
  test,
  onChoose,
}: {
  readonly test: OrgTestSummary;
  readonly onChoose: (to: string) => void;
}) {
  const latest = test.latestRun;
  return (
    <Row value={testValue(test)} to={projectTestPath(test.project.slug, test.slug)} onChoose={onChoose}>
      <Primary>{test.name}</Primary> <Secondary>{test.project.name}</Secondary>
      {latest !== null && (
        <>
          {' '}
          <Outcome mark={outcomeMark(latest.status, latest.verdict)} />
        </>
      )}
    </Row>
  );
}

/** "Run 12", or the short id a run with no number goes by everywhere else. */
function runLabel(run: RunRow): string {
  return run.runNumber === null || run.runNumber === undefined
    ? run.id.slice(0, 8)
    : runName(run.runNumber);
}

function RunResultRow({ run, onChoose }: { readonly run: RunRow; readonly onChoose: (to: string) => void }) {
  // The instant the run list shows and orders by: when the load test ran.
  const startedAt = run.toolStartedAt ?? run.startedAt;
  const subject = run.test?.name ?? run.simulation ?? null;
  return (
    <Row value={runValue(run)} to={runPath(run.id)} onChoose={onChoose}>
      <Primary>{runLabel(run)}</Primary>{' '}
      <Secondary>
        {subject === null ? run.project.name : `${subject} · ${run.project.name}`}
      </Secondary>{' '}
      <time dateTime={startedAt} className="shrink-0 text-[0.75rem] text-muted tabular-nums">
        {formatListInstant(startedAt)}
      </time>{' '}
      <Outcome mark={outcomeMark(run.status, run.verdict)} />
    </Row>
  );
}
