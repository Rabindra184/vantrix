import type { ToolAssertion } from '@perfportal/contracts';

/**
 * One simulation assertion, broken into the columns a reader scans.
 *
 * ═══ NOT A PARSER, AND THAT DISTINCTION IS THE WHOLE POINT ═══
 *
 * The obvious way to columns is to take apart "Search: 95th percentile of
 * response time is less than 100.0" with a regex. That would be a parser for
 * ANOTHER TOOL'S PROSE, written against the three shapes anybody happens to
 * have seen, and quietly wrong on the corpus run's twenty-nine.
 *
 * It is unnecessary. The engine evaluates `{ path, target, condition }` and
 * `describe()` renders the sentence FROM that; the pipeline stores the whole
 * evaluated object, so the structure has been in the database all along. It
 * was dropped on the way out — once by the persistence type, once by the API
 * mapper. This reads the structure; nothing here inspects the sentence.
 *
 * ═══ AND IT DEGRADES TO THE SENTENCE ═══
 *
 * `assertion` is optional: a run ingested before the decoder has prose and
 * nothing else, and a server that predates the widened contract sends none.
 * Every field below is therefore nullable, and the caller renders `expression`
 * whenever a cell would otherwise be empty. An assertion shape this build does
 * not know about — a future Path or Target — lands the same way, which is the
 * reason `expression` is kept rather than treated as a legacy fallback.
 */
export interface ToolAssertionParts {
  /** What it measures — "Search", "every request", "the run". */
  readonly target: string | null;
  /** Which number — "95th percentile", "error rate", "max". */
  readonly metric: string | null;
  /** The comparison, typeset: ≤, ≥, <, >, =, "between", "in". */
  readonly operator: string | null;
  /** The bound, with its unit where the metric has one. */
  readonly threshold: string | null;
  /** The unit `actualValue` is in, so the Actual column can carry it too. */
  readonly unit: 'ms' | '%' | 'requests' | null;
}

const STATUS_WORD: Record<string, string> = {
  all: 'all',
  ok: 'successful',
  ko: 'failed',
};

/** The ordinal the tool's own report uses — 50th, 95th, 99.9th. */
const ordinal = (rank: number): string => `${rank}th`;

function describeTarget(path: Record<string, unknown> | undefined): string | null {
  if (path === undefined) return null;
  switch (path['kind']) {
    case 'global':
      return 'the run';
    // EVERY request individually, which is a different claim from `global` —
    // the run's combined statistics can pass while one endpoint fails.
    case 'forAll':
      return 'every request';
    case 'details': {
      const parts = path['parts'];
      return Array.isArray(parts) && parts.length > 0 ? parts.join(' / ') : null;
    }
    default:
      return null;
  }
}

function describeMetric(
  target: Record<string, unknown> | undefined,
): { metric: string | null; unit: ToolAssertionParts['unit'] } {
  if (target === undefined) return { metric: null, unit: null };
  const status = typeof target['status'] === 'string' ? STATUS_WORD[target['status']] : undefined;
  switch (target['kind']) {
    case 'count':
      return { metric: `${status ?? ''} requests`.trim(), unit: 'requests' };
    case 'percent':
      return { metric: `${status ?? ''} requests`.trim(), unit: '%' };
    case 'responseTime': {
      const stat = target['stat'];
      if (stat === 'percentile') {
        const rank = target['rank'];
        return {
          metric: typeof rank === 'number' ? ordinal(rank) : 'percentile',
          unit: 'ms',
        };
      }
      return { metric: typeof stat === 'string' ? stat : null, unit: 'ms' };
    }
    default:
      return { metric: null, unit: null };
  }
}

/** `Number.isInteger` keeps a whole bound whole — 100, not 100.0. */
const bound = (v: number, unit: ToolAssertionParts['unit']): string =>
  unit === null ? String(v) : unit === 'ms' ? `${v} ms` : unit === '%' ? `${v}%` : String(v);

function describeCondition(
  condition: Record<string, unknown> | undefined,
  unit: ToolAssertionParts['unit'],
): { operator: string | null; threshold: string | null } {
  if (condition === undefined) return { operator: null, threshold: null };
  const value = condition['value'];
  const typeset: Record<string, string> = { lt: '<', lte: '≤', gt: '>', gte: '≥', is: '=' };
  const kind = condition['kind'];

  if (typeof kind === 'string' && kind in typeset) {
    return {
      operator: typeset[kind] ?? null,
      threshold: typeof value === 'number' ? bound(value, unit) : null,
    };
  }
  if (kind === 'between') {
    const lo = condition['lo'];
    const hi = condition['hi'];
    return {
      operator: 'between',
      threshold:
        typeof lo === 'number' && typeof hi === 'number'
          ? `${bound(lo, unit)} – ${bound(hi, unit)}`
          : null,
    };
  }
  if (kind === 'in') {
    const values = condition['values'];
    return {
      operator: 'in',
      threshold: Array.isArray(values) ? values.map((v) => bound(Number(v), unit)).join(', ') : null,
    };
  }
  return { operator: null, threshold: null };
}

export function toolAssertionParts(assertion: ToolAssertion): ToolAssertionParts {
  const decoded = assertion.assertion;
  if (decoded === undefined) {
    return { target: null, metric: null, operator: null, threshold: null, unit: null };
  }
  const { metric, unit } = describeMetric(decoded.target as Record<string, unknown>);
  const { operator, threshold } = describeCondition(
    decoded.condition as Record<string, unknown>,
    unit,
  );
  return {
    target: describeTarget(decoded.path as Record<string, unknown>),
    metric,
    operator,
    threshold,
    unit,
  };
}

/** `actualValue` with the unit its metric implies, or a dash for no measurement. */
export function formatActual(assertion: ToolAssertion): string {
  if (assertion.actualValue === null) return '—';
  const { unit } = toolAssertionParts(assertion);
  const rounded = Number(assertion.actualValue.toFixed(2));
  return unit === null ? String(rounded) : bound(rounded, unit);
}
