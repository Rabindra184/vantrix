import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunNote as RunNoteValue, RunResponse } from '@perfportal/contracts';
import { NOTE_MAX_LENGTH } from '@perfportal/contracts';
import RunNote from '../src/routes/RunNote';
import { runQueryKey, type RunDetail } from '../src/api/run';
import { formatInstant } from '../src/routes/format';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const RUN_ID = 'a66548b7-2962-43ff-8b93-7149a6f2a1b8';

const RUN: RunResponse = {
  id: RUN_ID,
  project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
  status: 'complete',
  verdict: 'not_evaluated',
  tool: 'gatling',
  startedAt: '2026-09-27T09:00:00.000Z',
  assertions: [],
};

const NOTE: RunNoteValue = {
  text: 'baseline after the cache change',
  updatedAt: '2026-09-27T09:30:00.000Z',
  updatedBy: { name: 'Asha' },
};

/** Every PUT body this render sent, parsed. */
const sent: unknown[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Answers PUT /v1/runs/{id}/note with whatever `respond` builds from the body sent. */
function stubPut(respond: (body: { note: string | null }) => Response) {
  sent.length = 0;
  vi.stubGlobal('fetch', (input: RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === `/v1/runs/${RUN_ID}/note` && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { note: string | null };
      sent.push(body);
      return Promise.resolve(respond(body));
    }
    return Promise.reject(new Error(`unexpected fetch ${url.pathname}`));
  });
}

/** The server's answer to a successful write: the note it stored. */
const stored = (body: { note: string | null }) =>
  json({ note: body.note === null ? null : { ...NOTE, text: body.note } });

/**
 * Stubs `PUT /v1/runs/{id}/note` with a promise the CALLER resolves by hand —
 * for asserting what the editor looks like while a save is still in flight,
 * which `stubPut`'s instantly-resolving stub cannot show.
 */
function stubPendingPut(): (body: { note: string | null }) => void {
  let resolve: (res: Response) => void = () => {};
  vi.stubGlobal('fetch', (input: RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === `/v1/runs/${RUN_ID}/note` && init?.method === 'PUT') {
      return new Promise<Response>((res) => {
        resolve = res;
      });
    }
    return Promise.reject(new Error(`unexpected fetch ${url.pathname}`));
  });
  return (body) => resolve(stored(body));
}

/**
 * THE NOTE COMES FROM THE CACHED RUN, as it does on the page. The harness
 * never fetches, so a note that appears after a save can only have been
 * written into the cache by RunNote itself — which is the claim: the page
 * shows the saved note at once rather than flashing the old state until the
 * refetch lands.
 */
/*
 * `canEdit` is `RunShell`'s answer to "may this reader edit run notes here"
 * (`run:note`). True by default: every case before the role cases further
 * down is about the note a reader who MAY edit it sees.
 */
function Harness({ canEdit = true }: { readonly canEdit?: boolean }) {
  const detail = useQuery<RunDetail>({
    queryKey: runQueryKey(RUN_ID),
    queryFn: () => Promise.reject(new Error('the harness never fetches')),
    enabled: false,
  }).data;
  return <RunNote runId={RUN_ID} note={detail?.run.note} canEdit={canEdit} />;
}

/** Mounts the note; `rerender(canEdit)` hands the SAME tree a new answer, as a role change does. */
function mount(note: RunNoteValue | null, canEdit = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData<RunDetail>(runQueryKey(RUN_ID), { state: 'ready', run: { ...RUN, note } });
  const tree = (may: boolean) => (
    <QueryClientProvider client={client}>
      <Harness canEdit={may} />
    </QueryClientProvider>
  );
  const view = render(tree(canEdit));
  return { rerender: (may: boolean) => view.rerender(tree(may)) };
}

describe('RunNote — reading', () => {
  it('shows the note, who wrote it and when', () => {
    mount(NOTE);
    expect(screen.getByTestId('run-note-text')).toHaveTextContent('baseline after the cache change');
    expect(screen.getByTestId('run-note-attribution')).toHaveTextContent(
      `Edited by Asha · ${formatInstant(NOTE.updatedAt!)}`,
    );
    expect(screen.getByRole('button', { name: 'Edit note' })).toBeInTheDocument();
  });

  it('names nobody once the author is gone, and keeps the words', () => {
    mount({ ...NOTE, updatedBy: null });
    expect(screen.getByTestId('run-note-text')).toHaveTextContent('baseline after the cache change');
    expect(screen.getByTestId('run-note-attribution')).toHaveTextContent(`Edited ${formatInstant(NOTE.updatedAt!)}`);
    expect(screen.getByTestId('run-note-attribution')).not.toHaveTextContent(/by/);
  });
});

describe('RunNote — writing', () => {
  it('offers to add a note when there is none, and opens the editor with the caret in it', async () => {
    mount(null);
    await userEvent.click(screen.getByRole('button', { name: 'Add a note' }));
    expect(screen.getByRole('textbox', { name: 'Run note' })).toHaveFocus();
  });

  it('counts against the limit and will not save a note that has not changed', async () => {
    mount(NOTE);
    await userEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    expect(screen.getByTestId('run-note-count')).toHaveTextContent(`${NOTE.text.length} / ${NOTE_MAX_LENGTH}`);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Run note' }), '!');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByTestId('run-note-count')).toHaveTextContent(`${NOTE.text.length + 1} / ${NOTE_MAX_LENGTH}`);
  });

  it('puts the note back on Escape and sends nothing', async () => {
    stubPut(stored);
    mount(NOTE);
    await userEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Run note' }), ' — never mind');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Run note' })).not.toBeInTheDocument();
    expect(screen.getByTestId('run-note-text')).toHaveTextContent(/^baseline after the cache change$/);
    expect(sent).toEqual([]);
  });

  it('locks the editor while a save is in flight, and unlocks once it resolves', async () => {
    const resolvePut = stubPendingPut();
    mount(NOTE);
    await userEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Run note' }), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Sent, and not yet answered: the textarea and Cancel are locked, and an
    // Escape aimed straight at the textarea — sidestepping which control the
    // click above left focused — does nothing rather than closing an editor
    // whose write cannot be taken back.
    expect(screen.getByRole('textbox', { name: 'Run note' })).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Run note' }), { key: 'Escape' });
    expect(screen.getByRole('textbox', { name: 'Run note' })).toHaveValue(`${NOTE.text}!`);

    resolvePut({ note: `${NOTE.text}!` });
    expect(await screen.findByTestId('run-note-text')).toHaveTextContent(`${NOTE.text}!`);
    expect(screen.queryByRole('textbox', { name: 'Run note' })).not.toBeInTheDocument();
  });

  it('saves the trimmed text, shows it at once, and gives focus back to the button that opened the editor', async () => {
    stubPut(stored);
    mount(null);
    await userEvent.click(screen.getByRole('button', { name: 'Add a note' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Run note' }), '  flaky environment, ignore  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByTestId('run-note-text')).toHaveTextContent('flaky environment, ignore');
    expect(sent).toEqual([{ note: 'flaky environment, ignore' }]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit note' })).toHaveFocus());
  });

  it('offers Remove note once the text is emptied, and removing sends null', async () => {
    stubPut(stored);
    mount(NOTE);
    await userEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Run note' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove note' }));

    expect(await screen.findByRole('button', { name: 'Add a note' })).toBeInTheDocument();
    expect(sent).toEqual([{ note: null }]);
    expect(screen.queryByTestId('run-note-text')).not.toBeInTheDocument();
  });

  it('keeps what was typed and says why when the server refuses it', async () => {
    stubPut(() =>
      json(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'The note is not valid: String must contain at most 500 character(s)',
          code: 'INVALID_RUN_NOTE',
          remediation: 'Send {"note": "<text>"} with 1 to 500 characters after trimming.',
        },
        400,
      ),
    );
    mount(null);
    await userEvent.click(screen.getByRole('button', { name: 'Add a note' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Run note' }), 'too long, the server says');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The note is not valid');
    expect(screen.getByRole('textbox', { name: 'Run note' })).toHaveValue('too long, the server says');
  });

  /**
   * ITEM 5 — A FAILED SAVE DOES NOT DROP FOCUS.
   *
   * `Button`'s `loading` prop disables the Save button while a save is in
   * flight, and a focused control that becomes disabled loses focus — so
   * without `onError`, the alert above would appear with focus on `<body>`.
   * The textarea stays `readOnly` (never `disabled`) throughout, so it is
   * still on screen and still the sensible place for focus to land: a reader
   * who sees the alert can correct the text and retry right where their
   * cursor was.
   */
  it('focuses the textarea again once a rejected save’s alert appears', async () => {
    stubPut(() =>
      json(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'The note is not valid: String must contain at most 500 character(s)',
          code: 'INVALID_RUN_NOTE',
          remediation: 'Send {"note": "<text>"} with 1 to 500 characters after trimming.',
        },
        400,
      ),
    );
    mount(NOTE);
    await userEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Run note' }), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('alert');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Run note' }));
  });
});

/**
 * ═══ ONLY A ROLE THAT MAY EDIT NOTES IS OFFERED TO (project access, PR 3) ═══
 *
 * `run:note` asks for Member. A Viewer — or anyone while access is not known,
 * or on a run with no project to ask about — reads the note and is offered no
 * way to change it: no Add a note, no Edit note, and so no Save or Remove
 * note behind them. The API refuses the write either way; hiding is for
 * clarity, so a reader is not handed a button whose click answers 403.
 */
describe('RunNote — only a reader who may edit notes is offered to', () => {
  it('shows an existing note read-only: its words and who wrote it, and no control to change it', () => {
    mount(NOTE, false);
    expect(screen.getByTestId('run-note-text')).toHaveTextContent('baseline after the cache change');
    expect(screen.getByTestId('run-note-attribution')).toHaveTextContent(
      `Edited by Asha · ${formatInstant(NOTE.updatedAt!)}`,
    );
    expect(screen.queryByRole('button', { name: 'Edit note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();
    // Nothing to press at all: the clamp toggle is drawn only for a note
    // that overflows, which jsdom's 0-by-0 layout never does.
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('draws nothing for a run with no note, rather than an empty region', () => {
    mount(null, false);
    expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();
    expect(screen.queryByTestId('run-note')).toBeNull();
  });

  it('offers Add a note and Edit note to a reader who may', () => {
    mount(null, true);
    expect(screen.getByRole('button', { name: 'Add a note' })).toBeInTheDocument();
    cleanup();
    mount(NOTE, true);
    expect(screen.getByRole('button', { name: 'Edit note' })).toBeInTheDocument();
  });

  /** Review Focus 3: a role that drops under an open page hides the control — the open editor with it. */
  it('takes an open editor away, Save and Remove note with it, when the right to edit goes', async () => {
    const { rerender } = mount(NOTE, true);
    await userEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Run note' }));
    expect(screen.getByRole('button', { name: 'Remove note' })).toBeInTheDocument();

    rerender(false);

    expect(screen.queryByRole('textbox', { name: 'Run note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByTestId('run-note-text')).toHaveTextContent('baseline after the cache change');
  });

  /**
   * Review Focus 3's other half: an editor opened before the role dropped
   * answers a refused save with the API's OWN refusal — both of its sentences,
   * what the action needs and what to do about it — never in silence.
   */
  it('shows a refused save in the API’s own two sentences', async () => {
    stubPut(() =>
      json(
        {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: 'Editing run notes needs the Member role in this project.',
          code: 'ROLE_REQUIRED',
          remediation: 'Ask an admin to change your role.',
        },
        403,
      ),
    );
    mount(NOTE, true);
    await userEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Run note' }), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Editing run notes needs the Member role in this project.');
    expect(alert).toHaveTextContent('Ask an admin to change your role.');
  });
});

/**
 * ITEM 4 — A CLOSED DISCLOSURE GETS FOCUS INSTEAD OF A BUTTON IT HIDES.
 *
 * On a phone a NOTED run shows RunNote under the heading; removing the note
 * moves it INTO the closed "Run details" `<details>` (`RunHeader` decides by
 * whether the run still has a note). `returnFocus` then finds the "Add a
 * note" toggle by test id inside that closed disclosure — content a closed
 * `<details>` does not render, so `.focus()` on it would be a no-op and
 * focus would fall to `<body>` in a real browser.
 *
 * MEASURED: jsdom does NOT itself refuse focus on content inside a closed
 * `<details>` — focusing an element there directly succeeds, same as a bare
 * `<summary>` with no `tabindex`. So a case asserting only "the toggle does
 * not have focus" would pass without the fix too (jsdom would just leave
 * focus wherever `.focus()` was last called, which without the branch IS the
 * toggle — itself "focused" successfully by jsdom's more permissive model).
 * The assertion has to be the POSITIVE claim the fix produces: that
 * `document.activeElement` is the disclosure's own `<summary>`.
 */
describe('RunNote — item 4: focus into a closed "Run details" disclosure', () => {
  it('focuses the wrapping disclosure’s summary when its toggle sits inside one that is closed', async () => {
    stubPut(stored);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<RunDetail>(runQueryKey(RUN_ID), { state: 'ready', run: { ...RUN, note: NOTE } });
    render(
      <QueryClientProvider client={client}>
        <details>
          <summary data-testid="wrapper-summary">Run details</summary>
          <Harness />
        </details>
      </QueryClientProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Run note' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove note' }));

    await screen.findByRole('button', { name: 'Add a note' });
    expect(document.activeElement).toBe(screen.getByTestId('wrapper-summary'));
  });
});

/**
 * ITEM 3 — CLAMPED TO THREE LINES UNTIL ASKED.
 *
 * jsdom lays nothing out, so `scrollHeight`/`clientHeight` are stubbed
 * directly on `HTMLElement.prototype` for the span of one case and restored
 * in that case's own cleanup — never a file-wide `afterEach`, since only
 * these cases need it and every other case in this file relies on jsdom's
 * real (0-by-0) layout meaning nothing overflows.
 */
describe('RunNote — item 3: the note clamps to three lines until asked', () => {
  /** Stubs both geometry properties for the span of one case; returns the
   *  function that restores jsdom's own descriptors. `ResizeObserver` needs
   *  no stub: it is undefined in jsdom, and RunNote's guard
   *  (`typeof ResizeObserver === 'function' ? … : null`) already skips
   *  creating one there — the initial synchronous measurement inside
   *  `useLayoutEffect` is what these cases exercise. */
  function stubGeometry(scrollHeight: number, clientHeight: number): () => void {
    // jsdom defines both as inherited getters on `Element.prototype`, so
    // `HTMLElement.prototype` has no OWN descriptor to save — restoring has
    // to delete the override rather than reinstate an `undefined` one.
    const scrollDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    const clientDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => clientHeight });
    return () => {
      if (scrollDesc === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
      else Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollDesc);
      if (clientDesc === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
      else Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientDesc);
    };
  }

  it('shows no toggle when the clamped text does not overflow three lines — the common case', () => {
    const restore = stubGeometry(60, 60);
    try {
      mount(NOTE);
      expect(screen.queryByTestId('run-note-expand')).not.toBeInTheDocument();
      expect(screen.getByTestId('run-note-text')).toHaveClass('line-clamp-3');
    } finally {
      restore();
    }
  });

  it('offers "Show all", then "Show less" once clicked, when the clamped text overflows', async () => {
    const restore = stubGeometry(120, 60);
    try {
      mount(NOTE);
      const text = screen.getByTestId('run-note-text');
      const toggle = await screen.findByTestId('run-note-expand');

      expect(toggle).toHaveTextContent('Show all');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveAttribute('aria-controls', text.id);
      expect(text).toHaveClass('line-clamp-3');

      await userEvent.click(toggle);

      expect(toggle).toHaveTextContent('Show less');
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(text).not.toHaveClass('line-clamp-3');
    } finally {
      restore();
    }
  });
});
