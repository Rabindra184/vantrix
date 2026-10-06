/**
 * ═══ A TEST'S LAST TEN p95s, AS A LINE (home page) ═══
 *
 * An inline SVG polyline and not an ECharts instance. The tests table draws one
 * of these per row, up to twenty-five on a page, and a chart instance each
 * would cost an initialisation, a ResizeObserver and a canvas for a figure
 * that carries ten numbers and no axes. What a reader wants from it is a
 * direction — is this getting slower — and ten points in 80 × 24 pixels say
 * that without a library.
 *
 * ═══ THE LINE IS DECORATION; THE CELL CARRIES THE FACTS ═══
 *
 * The SVG is `aria-hidden`. A screen-reader user is given the same two things
 * a sighted reader takes from it, as words: the latest value, in plain text
 * beside the line, and a visually hidden summary of the range ("last 10 runs:
 * 610–812 ms"). The points are not individually focusable or announced: they
 * are a shape, and ten announcements per row down a column of twenty-five
 * would bury the table.
 *
 * Points are spaced by POSITION in the history, not by when the runs
 * happened. A test that runs nightly and one that runs hourly then draw
 * comparable lines, and the line answers "how did the last ten compare", which
 * is the question the column is headed with.
 *
 * ═══ ONE MARK TAKES THE FAILED COLOUR, AND ONLY WHEN IT IS TRUE ═══
 *
 * The line stays the muted ink. The LAST point is the run the row's Last run
 * cell is about, so when that run needs attention its dot is drawn in the
 * failed colour and the eye can connect the two. The caller decides whether
 * that is so (`lastNeedsAttention`) because it takes both the run's outcome
 * AND whether the dot IS that run: a test whose newest run failed to ingest
 * has no p95 for it, so the last dot is an older, healthy run and must not
 * wear the newer one's colour. The colour is a 3:1 non-text mark, set inline
 * as a `style` — a status colour is never a Tailwind utility here
 * (`tokens.test.ts`), and a `fill` attribute would not take a `var()` in
 * every engine.
 */

const WIDTH = 80;
const HEIGHT = 24;
/** Room for the last dot's radius, so it is never clipped by the viewBox. */
const PAD = 2;

/** Two decimals: a sub-pixel position is the layout's business, not the markup's. */
const px = (n: number): string => n.toFixed(2);

interface Vertex {
  readonly x: number;
  readonly y: number;
}

/**
 * Where each point sits. x is even across the box; y is the value scaled
 * between this history's own minimum and maximum, flipped because SVG's y
 * grows downward and a slower run should be HIGHER. A flat history (one value,
 * or all the same) has no range to scale by, so it sits on the middle line
 * rather than dividing by zero.
 */
function layout(values: readonly number[]): Vertex[] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  const usable = HEIGHT - 2 * PAD;
  return values.map((value, i) => ({
    x: values.length === 1 ? WIDTH / 2 : PAD + (i * (WIDTH - 2 * PAD)) / (values.length - 1),
    y: span === 0 ? HEIGHT / 2 : PAD + ((hi - value) / span) * usable,
  }));
}

/** "last 10 runs: 610–812 ms"; a range that rounds to one number is said once. */
function summarise(values: readonly number[]): string {
  const rounded = values.map((v) => Math.round(v));
  const lo = Math.min(...rounded);
  const hi = Math.max(...rounded);
  const range = lo === hi ? `${lo} ms` : `${lo}–${hi} ms`;
  return `last ${values.length} ${values.length === 1 ? 'run' : 'runs'}: ${range}`;
}

export default function Sparkline({
  points,
  lastNeedsAttention,
}: {
  /** Oldest first, as `OrgTestSummary.p95History` is. */
  readonly points: readonly { readonly p95Ms: number }[];
  /** Required: a default would let a caller forget it and never colour a failure. */
  readonly lastNeedsAttention: boolean;
}) {
  if (points.length === 0) {
    return (
      <div data-testid="sparkline" className="flex items-center gap-2">
        <span aria-hidden="true" className="text-[0.8125rem] text-muted">
          —
        </span>
        <span className="sr-only">No completed runs with a p95</span>
      </div>
    );
  }

  const values = points.map((p) => p.p95Ms);
  const vertices = layout(values);
  const last = vertices[vertices.length - 1]!;
  return (
    <div data-testid="sparkline" className="flex items-center gap-2">
      <svg
        aria-hidden="true"
        focusable="false"
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="shrink-0 text-muted"
      >
        {vertices.length > 1 && (
          <polyline
            points={vertices.map((v) => `${px(v.x)},${px(v.y)}`).join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        <circle
          cx={px(last.x)}
          cy={px(last.y)}
          r={PAD}
          className="fill-current"
          style={lastNeedsAttention ? { fill: 'var(--color-status-failed)' } : undefined}
        />
      </svg>
      <span className="font-mono text-[0.8125rem] tabular-nums whitespace-nowrap text-primary">
        {Math.round(values[values.length - 1]!)} ms
      </span>
      <span className="sr-only">{summarise(values)}</span>
    </div>
  );
}
