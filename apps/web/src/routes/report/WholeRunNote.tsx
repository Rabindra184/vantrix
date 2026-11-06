import type { ReactNode } from 'react';

/**
 * A Requests chart that stays WHOLE-RUN under the Report's pick, with one
 * visible line above it saying so (spec section 6).
 *
 * Errors per second and Responses by status cannot narrow: error buckets are
 * run-wide, and the agent files status counts under every request together.
 * Beside six charts that DO narrow, a figure drawing the whole run with
 * nothing on it says the wrong thing about the pick. So the line is visible,
 * not behind an ⓘ — it changes how the figure must be read, the clean-UI
 * rule's own exception — and it sits in the chart's grid cell, above the
 * figure, so the two read as one.
 *
 * `min-w-0` because this is the grid cell now, not the figure: a grid item's
 * minimum is its content's, and a chart's canvas would otherwise hold the
 * column open past the grid.
 */
export default function WholeRunNote({ note, children }: { readonly note: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p data-testid="whole-run-note" className="text-[0.8125rem] text-muted">
        {note}
      </p>
      {children}
    </div>
  );
}
