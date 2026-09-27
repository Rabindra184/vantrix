import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
 * THE NOTE COMES FROM THE CACHED RUN, as it does on the page. The harness
 * never fetches, so a note that appears after a save can only have been
 * written into the cache by RunNote itself — which is the claim: the page
 * shows the saved note at once rather than flashing the old state until the
 * refetch lands.
 */
function Harness() {
  const detail = useQuery<RunDetail>({
    queryKey: runQueryKey(RUN_ID),
    queryFn: () => Promise.reject(new Error('the harness never fetches')),
    enabled: false,
  }).data;
  return <RunNote runId={RUN_ID} note={detail?.run.note} />;
}

function mount(note: RunNoteValue | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData<RunDetail>(runQueryKey(RUN_ID), { state: 'ready', run: { ...RUN, note } });
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
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
});
