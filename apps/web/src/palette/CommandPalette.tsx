import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OrgTestSummary, RunStatus, RunVerdict } from '@perfportal/contracts';
import { formatListInstant } from '../routes/format';
import { STATUS, VERDICT, type Mark } from '../routes/marks';
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
  /**
   * Where focus goes on close when the element that had it before the palette
   * opened is GONE — the header's Search button, in the app. Required, with no
   * default, because forgetting it is silent: focus would fall to `<body>`.
   */
  readonly returnFocusFallback: RefObject<HTMLElement | null>;
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
export default function CommandPalette({
  open,
  onOpenChange,
  returnFocusFallback,
}: CommandPaletteProps) {
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
            const recorded = returnFocusTo.current;
            returnFocusTo.current = null;
            /* Only an element still in the document. The one that had focus
               can be gone by the time the palette closes: an account-menu item
               (the menu shuts as the palette takes focus), or a control on a
               page that choosing a result navigated away from. Then the
               header's Search button, which opens this palette and is on every
               page — never <body>, which costs a keyboard reader their place. */
            const fallback = returnFocusFallback.current;
            const target =
              recorded !== null && recorded.isConnected
                ? recorded
                : fallback !== null && fallback.isConnected
                  ? fallback
                  : null;
            if (target !== null) {
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

/** Keys cmdk moves the highlight with. */
const MOVES_HIGHLIGHT: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

/** One row: what cmdk is told it is, where it goes, and what it shows. */
interface RowSpec {
  /**
   * The row's cmdk value. Unique across the whole list — cmdk treats two items
   * sharing a value as one, so a duplicate is a row that silently cannot be
   * reached — and also the row's React key, so a result present in two answers
   * is the SAME row in both.
   */
  readonly value: string;
  readonly to: string;
  readonly content: ReactNode;
}

interface Section {
  readonly heading: string;
  readonly rows: readonly RowSpec[];
}

/**
 * What the list draws, in its fixed order: Go to, Projects, Pages, Tests,
 * Runs, Run by number — each only when it has a row.
 *
 * ONE array, read by both the JSX and the highlight below, so the rows cmdk is
 * told about and the rows on screen cannot be two lists that drift apart.
 */
function sectionsOf(groups: PaletteGroups): Section[] {
  const sections: Section[] = [
    { heading: 'Go to', rows: groups.goTo.map(destinationRow) },
    { heading: 'Projects', rows: groups.projects.items.map(projectRow) },
    { heading: 'Pages', rows: groups.pages.items.map(destinationRow) },
    { heading: 'Tests', rows: groups.tests.items.map(testRow) },
    { heading: 'Runs', rows: groups.runs.items.map(runResultRow) },
    { heading: 'Run by number', rows: groups.runByNumber.items.map(runNumberRow) },
  ];
  return sections.filter((section) => section.rows.length > 0);
}

function PaletteSearch({ onChoose }: { readonly onChoose: (to: string) => void }) {
  const [raw, setRaw] = useState('');
  const groups = usePaletteSearch(raw);
  const announcement = useResultAnnouncement(groups);
  const sections = sectionsOf(groups);
  const values = sections.flatMap((section) => section.rows.map((row) => row.value));

  /* ═══ THE HIGHLIGHT IS HELD HERE, BECAUSE cmdk LOSES IT ═══

     cmdk keeps the highlighted row's value and, when that row unmounts, is
     meant to move the highlight to the first row left. It schedules that
     check under ONE key per batch, so when several rows unmount in the same
     commit — the whole "Go to" list as a search lands, or `smo`'s three tests
     narrowed to the one `smok` still matches — only the LAST row's check
     survives, and unless that happens to be the highlighted one the value goes
     on naming a row that no longer exists. Nothing is then highlighted and
     Enter does nothing, on exactly the keystroke a reader makes most.

     So the value is controlled, and one that is no longer on screen falls to
     the FIRST row on screen — whether or not any row mounted, which is the
     case cmdk's own "pick the first" (it runs only as a row mounts) cannot
     reach. `''` only when there is no row at all. */
  const [highlighted, setHighlighted] = useState('');
  const value = values.includes(highlighted) ? highlighted : (values[0] ?? '');

  /* ═══ AN ENTER PRESSED BEFORE ITS ANSWER IS QUEUED, NOT SWALLOWED ═══

     While `groups.pending` the rows on screen answer an earlier query (or no
     query yet), so choosing one would act on what was typed BEFORE. The
     Enter is held instead: the pause is ended so the search for what the
     input says runs now, and once every group has answered it the
     highlighted row is chosen exactly as Enter would choose it. The
     highlight is reset when the Enter is queued, so that row is the FIRST of
     the answer: the reader has seen none of it, and a row they had arrowed to
     before pressing Enter was one of the PREVIOUS query's rows — the very
     thing this exists not to act on. Typing or moving the highlight after the
     Enter withdraws it; closing unmounts this component and the flag with it. */
  const [chooseWhenSettled, setChooseWhenSettled] = useState(false);
  const rows = sections.flatMap((section) => section.rows);
  useEffect(() => {
    if (!chooseWhenSettled || groups.pending) return;
    setChooseWhenSettled(false);
    const row = rows.find((r) => r.value === value);
    if (row !== undefined) onChoose(row.to);
  });

  /* cmdk tells the input which option is highlighted (`aria-activedescendant`)
     only when IT moves the highlight — a value handed to it from outside, as
     above, highlights the row and leaves the input naming the old one, or
     none. A screen reader would then announce nothing as the highlight moves.
     So the input's attribute is set from the row actually carrying `value`.
     cmdk renders the same attribute, and when it next moves the highlight
     itself it writes its own, equally correct, answer over this one. */
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const inputEl = inputRef.current;
    const listEl = listRef.current;
    if (inputEl === null || listEl === null) return;
    const row =
      value === ''
        ? undefined
        : [...listEl.querySelectorAll<HTMLElement>('[cmdk-item]')].find(
            (item) => item.getAttribute('data-value') === value,
          );
    if (row === undefined || row.id === '') inputEl.removeAttribute('aria-activedescendant');
    else inputEl.setAttribute('aria-activedescendant', row.id);
  });

  return (
    /* `vimBindings` off: cmdk otherwise moves the highlight on Ctrl+K, and
       Ctrl+K is this palette's own shortcut to close. */
    <Command
      shouldFilter={false}
      label="Search PerfPortal"
      vimBindings={false}
      value={value}
      onValueChange={setHighlighted}
      onKeyDown={(event) => {
        /* A key that moves the highlight is a reader choosing for themselves:
           a queued Enter no longer speaks for them. */
        if (MOVES_HIGHLIGHT.has(event.key)) {
          setChooseWhenSettled(false);
          return;
        }
        /* Enter while what is on screen does not yet answer what was typed:
           the key is withheld from cmdk (it honours `defaultPrevented`), the
           pause is ended so the right search runs now, and the choice is made
           when that answer is complete — see `chooseWhenSettled` above. An
           IME composition's Enter is the composition's, not ours: cmdk skips
           it on `isComposing || keyCode === 229`, and so must this, because
           Safari fires the Enter that COMMITS a composition after the
           composition has ended (`isComposing` false) with `keyCode` 229 —
           queued, it would navigate on a key the reader pressed to confirm a
           character. */
        if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) {
          return;
        }
        if (!groups.pending) return;
        event.preventDefault();
        groups.flush();
        setHighlighted('');
        setChooseWhenSettled(true);
      }}
    >
      <Command.Input
        ref={inputRef}
        value={raw}
        onValueChange={(next) => {
          // More typing is a different question: a queued Enter answered none of it.
          setChooseWhenSettled(false);
          setRaw(next);
        }}
        placeholder="Search projects, tests and runs"
        className="h-12 w-full border-b border-default bg-transparent px-4 text-[0.9375rem] text-primary outline-none placeholder:text-muted"
      />
      <Command.List
        ref={listRef}
        label="Results"
        className="max-h-[min(60vh,26rem)] overflow-x-hidden overflow-y-auto p-1.5"
      >
        {sections.map((section) => (
          <PaletteGroup key={section.heading} heading={section.heading}>
            {section.rows.map((row) => (
              <Row key={row.value} row={row} onChoose={onChoose} />
            ))}
          </PaletteGroup>
        ))}
      </Command.List>

      {/* Outside the listbox, so they are read as text rather than skipped as
          non-options, and below it, so a failure stays in view however long
          the list above has grown. One quiet line per failed group, in the
          groups' own order. */}
      <PaletteNotes groups={groups} />

      {/* Mounted EMPTY for as long as the palette is, and filled once a typed
          query settles. A screen reader announces a live region's CHANGES; a
          region mounted already holding its message has not changed, it was
          inserted (the lesson `ProjectRail`'s own region records). It still
          exists only while the dialog does, so there is never more than one. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement ?? ''}
      </p>
    </Command>
  );
}

/**
 * The count a screen reader hears, or null when there is none to say.
 *
 * Null with nothing typed — "Go to" is not a search result — and null until a
 * typed query has SETTLED for the first time, so the region never holds a
 * half-counted number. Once it has a count it KEEPS the last settled one while
 * the next query loads (the rows on screen are still that answer's, by
 * `keepPreviousData`), and changes only when the next answer is complete.
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
        <span className="block px-2 pt-2 pb-1 text-[0.6875rem] tracking-wide text-muted uppercase">
          {heading}
        </span>
      }
    >
      {children}
    </Command.Group>
  );
}

/** One option. Its `value` identifies it to cmdk and is never shown. */
function Row({ row, onChoose }: { readonly row: RowSpec; readonly onChoose: (to: string) => void }) {
  return (
    <Command.Item
      value={row.value}
      onSelect={() => onChoose(row.to)}
      className="flex max-w-full min-w-0 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[0.8125rem] select-none data-[selected=true]:bg-sunken"
    >
      {row.content}
    </Command.Item>
  );
}

/* A row's parts. Each truncates on its own and none can widen the row; the
   spaces between them are real text nodes, because a flex gap moves pixels and
   a screen reader reads text (CLAUDE.md, "A MARGIN IS NOT A SPACE").

   ═══ THE SECONDARY TEXT TAKES WHAT THE NAME LEAVES, AND NOTHING IT HAS NOT ═══

   This was `shrink-[2]`, meant as "the secondary text gives way twice as fast",
   and it does not: a flex item loses space in proportion to its shrink factor
   TIMES ITS UNCLAMPED SIZE, and `max-w-[50%]` clamps a size only after that
   sum is taken. Beside a long class the secondary text therefore counts at its
   full length, the row overshoots by about that much, and a short primary —
   "Run 2" — loses about HALF of itself (its factor over the secondary's)
   whatever the screen: it drew as "R…" at 375px with the class beside it
   still holding a hundred pixels.
   Raising the factor only shrinks that fraction; the primary still loses a
   sliver, and a clipped sliver is an ellipsis. Measured in a browser (jsdom
   lays nothing out): `command-palette.spec.ts`.

   So the secondary text is the REMAINDER instead: `flex-1` is a basis of zero
   that grows into whatever space is left, capped at half the row. The primary
   keeps its full width while there is any, shrinks only once the row cannot
   hold it (the one item that then can), and the secondary text reaches nothing
   before the name has what it needs. The OUTCOME that ends a row carries its
   own `ml-auto`, so it sits flush right, one column down the list; a run's
   time sits after the secondary text and lines up only while that text has
   not reached its cap. */
function Primary({ children }: { readonly children: ReactNode }) {
  return <span className="min-w-0 max-w-full truncate">{children}</span>;
}

function Secondary({ children }: { readonly children: ReactNode }) {
  return <span className="min-w-0 max-w-[50%] flex-1 truncate text-muted">{children}</span>;
}

/**
 * A result's outcome: the GLYPH in its status colour, the WORD in the primary
 * text colour.
 *
 * Not `marks.tsx`'s `Marked`, which colours the word too — right on the card
 * ground its other callers sit on, and wrong here: a highlighted row is drawn
 * on `bg-sunken`, where the failed tone as text measures 4.27:1 and pending
 * 4.44:1 in the light theme, under AA's 4.5. A glyph is a non-text mark, which
 * needs 3:1, and both tones clear that on both grounds — the rule `FormField`'s
 * notice lines already follow. The glyph, word and colour are still the mark's
 * own, so a status that changes either changes here too.
 */
function Outcome({ mark }: { readonly mark: Mark }) {
  return (
    <span className="ml-auto shrink-0 text-[0.75rem] text-primary">
      <span aria-hidden="true" style={{ color: mark.colour }}>
        {mark.glyph}
      </span>{' '}
      <span>{mark.label}</span>
    </span>
  );
}

/**
 * One mark for a run's outcome, as the run list's two badges would read in
 * one: a finished run's VERDICT is the news, an unfinished one's STATE is.
 */
function outcomeMark(status: RunStatus, verdict: RunVerdict | null): Mark {
  return status === 'complete' ? VERDICT[verdict ?? 'none'] : STATUS[status];
}

/** "Run 12", or the short id a run with no number goes by everywhere else. */
function runLabel(run: RunRow): string {
  return run.runNumber === null || run.runNumber === undefined
    ? run.id.slice(0, 8)
    : runName(run.runNumber);
}

function destinationRow(destination: Destination): RowSpec {
  // A destination's id is already unique and already prefixed by its kind.
  return {
    value: destination.id,
    to: destination.to,
    content: <Primary>{destination.label}</Primary>,
  };
}

function projectRow(project: ProjectRef): RowSpec {
  return {
    value: `project:${project.slug}`,
    to: projectPath(project.slug),
    content: (
      <>
        <Primary>{project.name}</Primary> <Secondary>{project.slug}</Secondary>
      </>
    ),
  };
}

function testRow(test: OrgTestSummary): RowSpec {
  const latest = test.latestRun;
  return {
    value: `test:${test.id}`,
    to: projectTestPath(test.project.slug, test.slug),
    content: (
      <>
        <Primary>{test.name}</Primary> <Secondary>{test.project.name}</Secondary>
        {latest !== null && (
          <>
            {' '}
            <Outcome mark={outcomeMark(latest.status, latest.verdict)} />
          </>
        )}
      </>
    ),
  };
}

function runResultRow(run: RunRow): RowSpec {
  // The instant the run list shows and orders by: when the load test ran.
  const startedAt = run.toolStartedAt ?? run.startedAt;
  const subject = run.test?.name ?? run.simulation ?? null;
  return {
    value: `run:${run.id}`,
    to: runPath(run.id),
    content: (
      <>
        <Primary>{runLabel(run)}</Primary>{' '}
        <Secondary>
          {subject === null ? run.project.name : `${subject} · ${run.project.name}`}
        </Secondary>{' '}
        <time dateTime={startedAt} className="shrink-0 text-[0.75rem] text-muted tabular-nums">
          {formatListInstant(startedAt)}
        </time>{' '}
        <Outcome mark={outcomeMark(run.status, run.verdict)} />
      </>
    ),
  };
}

function runNumberRow({ run, test }: RunByNumberHit): RowSpec {
  return {
    // `num:`, not `run:` — the same run can also be a Runs result.
    value: `num:${run.id}`,
    to: runPath(run.id),
    content: <Primary>{`${runLabel(run)} · ${test.name} · ${test.project.name}`}</Primary>,
  };
}
