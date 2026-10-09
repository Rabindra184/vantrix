import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { NOTE_MAX_LENGTH, type RunNote as RunNoteValue } from '@perfportal/contracts';
import Button from '../components/Button';
import { ProblemError } from '../api/fetch';
import { putRunNote, runQueryKey, type RunDetail } from '../api/run';
import { formatInstant } from './format';

/**
 * ═══ THE NOTE A PERSON KEEPS ON A RUN ═══
 * (docs/superpowers/specs/2026-09-27-run-note-design.md)
 *
 * "baseline after the cache change", "flaky environment, ignore". NOT the
 * run's description, which RunHeader prints above this: that is Gatling's own
 * text, and this component never touches it.
 *
 * A labelled region with NO heading. RunHeader renders above the tab outlet,
 * so a heading here would put a rung in every tab's outline — the rule
 * RunShell's other chrome already follows.
 *
 * WHERE it sits is RunHeader's decision, not this component's: under the
 * heading, except on a phone with no note, where it goes inside the Run
 * details disclosure. That is why focus is returned by test id rather than a
 * ref — see returnFocus.
 */
const TOGGLE_TEST_ID = 'run-note-toggle';
/** The "Show all"/"Show less" toggle — its OWN test id, distinct from
 *  TOGGLE_TEST_ID above: returnFocus finds the EDIT toggle by that one, and
 *  sharing it would return focus to whichever button happened to render last. */
const EXPAND_TEST_ID = 'run-note-expand';

export default function RunNote({
  runId,
  note,
  canEdit,
}: {
  readonly runId: string;
  /** The run's note; null or undefined when it has none (undefined from an
   *  API pod that predates the field). */
  readonly note: RunNoteValue | null | undefined;
  /**
   * Whether the reader may change the note — `run:note` in the run's own
   * project, which `RunShell` asks once. False draws the note read-only: no
   * Add a note, no Edit note, and so no editor with its Save or Remove note.
   * It is false while access is not known, too (hidden until known), and for
   * a run with no project to ask about.
   *
   * REQUIRED, with no default: either default would be silent — `true` offers
   * a Viewer a button whose click answers 403, `false` takes the editor from
   * everyone who forgot to pass it.
   */
  readonly canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  const countId = useId();

  // ═══ ITEM 3 — CLAMPED TO THREE LINES UNTIL ASKED ═══
  const textRef = useRef<HTMLParagraphElement>(null);
  const textId = useId();
  const [expanded, setExpanded] = useState(false);
  /** Whether the CLAMPED text actually overflows three lines — the toggle
   *  renders only then, so a one-line note never carries a useless button. */
  const [overflowing, setOverflowing] = useState(false);

  const existing = note?.text ?? null;
  const trimmed = draft.trim();
  const removing = trimmed === '' && existing !== null;

  const save = useMutation({
    mutationFn: (text: string | null) => putRunNote(runId, text),
    onSuccess: (saved) => {
      // Into the cached run FIRST, so the page shows the saved note in the
      // same paint the editor closes in — rather than the old state until the
      // refetch lands. Then refetch the run (EXACT: every metrics query key
      // starts with the run's own, and a prefix match would refetch them all)
      // and the run lists, which show the text too.
      queryClient.setQueryData<RunDetail>(runQueryKey(runId), (old) => withNote(old, saved.note));
      void queryClient.invalidateQueries({ queryKey: runQueryKey(runId), exact: true });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      setEditing(false);
      returnFocus();
    },
    // ═══ ITEM 5 — A FAILED SAVE DOES NOT DROP FOCUS ═══
    // `Button`'s `loading` prop disables the Save button while a save is in
    // flight (`disabled={disabled === true || loading}`), and a focused
    // control that becomes disabled loses focus — so on failure the alert
    // that appears next to it would land with focus on `<body>`. The textarea
    // is `readOnly` (never `disabled`) during the save and editable again the
    // moment it resolves, so it is still on screen and still a sensible place
    // for focus to land: a reader who sees the alert can correct the text and
    // retry from right where their cursor was.
    onError: () => inputRef.current?.focus(),
  });

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useLayoutEffect(() => {
    // Once expanded, this effect does nothing — `overflowing` keeps whatever
    // it last measured WHILE CLAMPED, which is what keeps the toggle showing
    // once a reader has asked to see the whole note (it would otherwise
    // measure the UNCLAMPED box, find nothing overflowing it, and pull the
    // toggle out from under them).
    if (expanded) return;
    const el = textRef.current;
    if (el == null) return;
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    measure();
    // ResizeObserver, not a one-off measurement: a note's clamped height can
    // still change after this first paint (a web font swapping in). Guarded
    // the same way Chart.tsx guards its own resize observer, so a note
    // mounted in jsdom — which has none — measures once and never throws.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [note?.text, expanded]);

  const open = () => {
    save.reset();
    setDraft(existing ?? '');
    setEditing(true);
  };
  const cancel = () => {
    save.reset();
    setEditing(false);
    returnFocus();
  };
  const submit = () => save.mutate(removing ? null : trimmed);
  const canSubmit = !save.isPending && (removing || (trimmed !== '' && trimmed !== existing));

  /* `canEdit` gates the OPEN editor too, not only the button that opens it:
     a role that drops while the editor is open (Review Focus 3) takes it
     away, rather than leaving a Save whose click can only be refused. The
     `editing` state is kept, so a role restored before the page moves on
     brings the draft back as it was. */
  if (editing && canEdit) {
    return (
      <section aria-label="Run note" data-testid="run-note" className="flex max-w-2xl flex-col gap-2">
        <label htmlFor={fieldId} className="text-[0.75rem] font-medium text-muted">
          Run note
        </label>
        <textarea
          ref={inputRef}
          id={fieldId}
          value={draft}
          rows={3}
          maxLength={NOTE_MAX_LENGTH}
          aria-describedby={countId}
          onChange={(event) => setDraft(event.currentTarget.value)}
          // LOCKED while a save is in flight, rather than aborted: a PUT
          // already sent is committed server-side the moment it lands, so
          // `save.reset()` on Cancel or Escape cannot un-send it — it can
          // only make the editor lie about having cancelled while the write
          // still completes underneath it (onSuccess would then write the
          // cache and pull focus back to the toggle after the reader
          // believed they had backed out). `readOnly`, not `disabled`:
          // disabling a focused textarea blurs it, and focus should stay put
          // until the save resolves and returnFocus moves it deliberately.
          readOnly={save.isPending}
          onKeyDown={(event) => {
            if (save.isPending) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              cancel();
            }
          }}
          className="w-full rounded-lg border border-default bg-surface px-3 py-2 text-[0.8125rem] leading-relaxed text-primary"
        />
        <p id={countId} data-testid="run-note-count" className="font-mono text-[0.75rem] text-muted">
          {draft.length} / {NOTE_MAX_LENGTH}
        </p>
        {/* The API's remediation rides under its detail. For a save refused
            because the reader's role dropped after the editor opened, the
            detail says what editing notes needs and the remediation what to
            do about it — the refusal in the API's own two sentences, never
            half of it (Review Focus 3). */}
        {save.error ? (
          <div role="alert" className="text-[0.75rem]">
            <p style={{ color: 'var(--color-status-failed)' }}>
              {save.error instanceof ProblemError ? save.error.detail : 'The note could not be saved. Try again.'}
            </p>
            {save.error instanceof ProblemError && save.error.remediation !== '' && (
              <p className="text-muted">{save.error.remediation}</p>
            )}
          </div>
        ) : null}
        <div className="flex gap-2">
          {/* SECONDARY, not primary: Button's rule is one primary per screen,
              and this editor is opened on a page that already has its own. */}
          <Button size="sm" onClick={submit} disabled={!canSubmit} loading={save.isPending}>
            {removing ? 'Remove note' : 'Save'}
          </Button>
          {/* Locked with the textarea while a save is in flight — see the
              readOnly comment above. */}
          <Button size="sm" variant="ghost" onClick={cancel} disabled={save.isPending}>
            Cancel
          </Button>
        </div>
      </section>
    );
  }

  if (note == null) {
    /* Nothing to read and nothing this reader may write: no region at all,
       rather than a labelled "Run note" landmark holding nothing. */
    if (!canEdit) return null;
    return (
      <section aria-label="Run note" data-testid="run-note">
        <button type="button" data-testid={TOGGLE_TEST_ID} onClick={open} className={LINK_BUTTON}>
          Add a note
        </button>
      </section>
    );
  }

  return (
    <section
      aria-label="Run note"
      data-testid="run-note"
      /* The accent rule sets a PERSON's words apart from the tool's muted
         description directly above: "ignore this run" must not read as
         metadata. */
      className="flex max-w-2xl flex-col gap-1 border-l-2 border-accent pl-3"
    >
      <p
        ref={textRef}
        id={textId}
        data-testid="run-note-text"
        // `line-clamp` works with `whitespace-pre-line` — a person's own line
        // breaks are part of the note, and stay part of it whether clamped or
        // not; the clamp just stops counting past the third rendered line.
        className={
          expanded
            ? 'text-[0.8125rem] leading-relaxed whitespace-pre-line break-words text-primary'
            : 'line-clamp-3 text-[0.8125rem] leading-relaxed whitespace-pre-line break-words text-primary'
        }
      >
        {note.text}
      </p>
      <p className="flex flex-wrap items-center gap-x-2 text-[0.75rem] text-muted">
        <span data-testid="run-note-attribution">{attribution(note)}</span>
        {overflowing ? (
          <button
            type="button"
            data-testid={EXPAND_TEST_ID}
            aria-expanded={expanded}
            aria-controls={textId}
            onClick={() => setExpanded((was) => !was)}
            className={LINK_BUTTON}
          >
            {expanded ? 'Show less' : 'Show all'}
          </button>
        ) : null}
        {canEdit && (
          <button type="button" data-testid={TOGGLE_TEST_ID} onClick={open} className={LINK_BUTTON}>
            Edit note
          </button>
        )}
      </p>
    </section>
  );
}

const LINK_BUTTON =
  'w-fit cursor-pointer text-[0.75rem] font-medium text-accent hover:underline hover:underline-offset-2';

/** "Edited by Asha · <instant>", or "Edited <instant>" once the author is gone. */
function attribution(note: RunNoteValue): string {
  const when = note.updatedAt === null ? '' : formatInstant(note.updatedAt);
  if (note.updatedBy === null) return when === '' ? 'Edited' : `Edited ${when}`;
  return when === '' ? `Edited by ${note.updatedBy.name}` : `Edited by ${note.updatedBy.name} · ${when}`;
}

/** The cached run with its note replaced, whichever state the run is in. */
function withNote(old: RunDetail | undefined, note: RunNoteValue | null): RunDetail | undefined {
  if (old === undefined) return old;
  return old.state === 'ready'
    ? { state: 'ready', run: { ...old.run, note } }
    : { state: 'processing', run: { ...old.run, note } };
}

/**
 * Focus back to the button that opened the editor — FOUND BY ITS TEST ID after
 * the next render, not held in a ref. A phone's FIRST note moves this
 * component out of the Run details disclosure (RunHeader places it by whether
 * a note exists), which remounts it: a ref would point at a button that no
 * longer exists.
 *
 * A phone's REMOVE does the same move in the other direction: the run now
 * has no note, so `noteInDetails` (`RunHeader`) becomes true and this
 * component's "Add a note" toggle renders INSIDE the closed "Run details"
 * `<details>` — content a closed disclosure does not render, so `.focus()`
 * on it is a no-op and focus falls to `<body>`. When the found toggle has a
 * closed `<details>` ancestor, focus that disclosure's own `<summary>`
 * instead: the nearest thing still on screen, and one tap from reopening it.
 */
function returnFocus(): void {
  window.setTimeout(() => {
    const toggle = document.querySelector<HTMLElement>(`[data-testid="${TOGGLE_TEST_ID}"]`);
    if (toggle === null) return;
    const closedDetails = toggle.closest<HTMLDetailsElement>('details:not([open])');
    if (closedDetails !== null) {
      closedDetails.querySelector<HTMLElement>('summary')?.focus();
      return;
    }
    toggle.focus();
  }, 0);
}
