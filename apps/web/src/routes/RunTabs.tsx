import { NavLink } from 'react-router-dom';
import { runChartsPath, runErrorsPath, runPath } from './paths';

/**
 * A run's three sections, as navigation.
 *
 * `NavLink` supplies `aria-current="page"` itself when its `to` matches — and
 * `end` on the Overview link is what stops it matching `/charts` and
 * `/errors` too, since both start with the run's own path.
 *
 * The error count is DISTINCT MESSAGES, which only `/errors` knows. The stats
 * row's `koCount` is failed requests — 24 where this is 2 on the reference
 * run — so using it would put a plausible wrong number on screen.
 *
 * `errorCount` is `number | null`, not defaulted to `0` by its caller: `null`
 * means "not yet known" — `errorsQuery` still pending, or failed — and `0`
 * means the run genuinely has no distinct error messages. `RunShell` used to
 * collapse the two with `?? 0`, which read "Errors (0)" for a run whose count
 * had not arrived, and read it forever if the fetch failed outright while the
 * panel beneath it rendered `role="alert"` — a confident zero over a stated
 * failure. `peakUsers` two lines up in `RunHeader` already draws this
 * distinction (`runUsers.ts`'s own "zero is a measurement"); this is the same
 * argument applied to the tab that sits right beside it.
 */
export default function RunTabs({
  runId,
  errorCount,
}: {
  readonly runId: string;
  readonly errorCount: number | null;
}) {
  const base = 'border-b-2 px-3 py-2 text-sm';
  const style = ({ isActive }: { isActive: boolean }) =>
    isActive
      ? `${base} border-accent text-primary font-semibold`
      : `${base} border-transparent text-muted`;

  return (
    <nav aria-label="Run sections" className="flex gap-1 border-b border-default">
      <NavLink to={runPath(runId)} end className={style}>
        Overview
      </NavLink>
      <NavLink to={runChartsPath(runId)} className={style}>
        Charts
      </NavLink>
      <NavLink to={runErrorsPath(runId)} className={style}>
        {errorCount === null ? 'Errors' : `Errors (${errorCount})`}
      </NavLink>
    </nav>
  );
}
