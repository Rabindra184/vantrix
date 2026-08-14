import { Link, useParams } from 'react-router-dom';

/**
 * `/runs/:runId/requests/:name` and `/runs/:runId/groups/:name`, before the
 * pages that fill them exist.
 *
 * WHY THIS FILE EXISTS AT ALL. G-16 requires every row of the statistics table
 * to link to its own detail page, and design §1 puts those two pages in later
 * sub-projects (piece 3, §13.3 RQ-01…RQ-11; piece 4, §13.4 GR-01…GR-09). That
 * leaves three options and only one honest one:
 *
 *   - omit the links until the pages exist — which drops a requirement of this
 *     piece for the convenience of the next;
 *   - let the links 404 — except this app has no 404: `App.tsx`'s catch-all
 *     redirects an unknown path to `/runs`, so a reader who clicked a row would
 *     silently land on the run LIST, having apparently lost their run;
 *   - say what is true. This page.
 *
 * It is deliberately a dead end with a way back, not a preview. Rendering an
 * empty version of the real page — headings over nothing, a chart with no data
 * — would read as a request whose detail was measured and found to be empty,
 * which is exactly the failure mode the run detail page's `Processing` branch
 * was written to avoid.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE NAME IS DISPLAYED, NOT VALIDATED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `useParams` decodes the segment, so `Catalog%2FRecommendations` arrives here
 * as `Catalog/Recommendations` — one param carrying a group's full path,
 * because `detailPathFor` encodes it as ONE segment on the way out. Nothing
 * here checks that the name exists in the run: this page makes no claim about
 * it beyond "this is what you clicked", and asking the API to confirm a name
 * for a page that will not use the answer would be a request issued to make a
 * placeholder feel more real.
 *
 * It is rendered as text through React, which escapes it — the name is a
 * request name out of an uploaded simulation log, i.e. a string an ingesting
 * client controls, and it reaches the DOM as content and never as markup.
 */

/** Which of the two later pages this address belongs to. */
export type DetailKind = 'request' | 'group';

const WHAT: Record<DetailKind, { readonly noun: string; readonly builds: string }> = {
  request: {
    noun: 'request',
    builds:
      'It will show this request’s own response times, its rate over time, the saturation ' +
      'scatter and the errors recorded against it.',
  },
  group: {
    noun: 'group',
    builds:
      'It will show this group’s cumulated and duration statistics side by side, and the ' +
      'requests it contains.',
  },
};

export default function DetailPlaceholder({ kind }: { kind: DetailKind }) {
  const { runId, name } = useParams<{ runId: string; name: string }>();
  const what = WHAT[kind];

  return (
    <div className="flex flex-col items-start gap-3">
      {/* The row the reader clicked is the heading, so the page they landed on
          is recognisably the one they asked for — a placeholder that did not
          name it would be indistinguishable from a broken link. */}
      <h1 className="text-2xl font-semibold">{name ?? `This ${what.noun}`}</h1>
      <p role="status">
        The {what.noun} detail page is not built yet.
      </p>
      <p className="text-[var(--color-text-muted)]">{what.builds}</p>
      {/* Back to the run, not to the run list: the reader came from one row of
          one run's statistics table, and that table is where the rest of their
          question is. `runId` is always present in practice — neither route
          matches without it — and the list is the honest fallback if it is
          somehow not. */}
      {runId === undefined ? (
        <Link to="/runs" className="underline">
          Back to all runs
        </Link>
      ) : (
        <Link to={`/runs/${encodeURIComponent(runId)}`} className="underline">
          Back to this run
        </Link>
      )}
    </div>
  );
}
