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
 */
export default function RunTabs({
  runId,
  errorCount,
}: {
  readonly runId: string;
  readonly errorCount: number;
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
        Errors ({errorCount})
      </NavLink>
    </nav>
  );
}
