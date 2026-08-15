import type { UsersResponse } from '@perfportal/contracts';
import { useMemo } from 'react';
import Chart from './Chart';
import { toConcurrentUsers, toUserStartRate } from './transforms/users';

/**
 * §13.2 ⑦ concurrent users over time (Appendix A G-18/G-19) and ⑦ᵇ users
 * started per second (G-26).
 *
 * TWO COMPONENTS IN ONE FILE, because they are two views of ONE payload. Both
 * read `GET /v1/runs/:id/users`, and keeping them together is what makes it
 * obvious at a glance that they read different FIELDS of it — the mistake this
 * pair exists to prevent (design §10, falsification checkpoint #2) is exactly
 * the one that becomes invisible when the two transforms are read in separate
 * files. Named exports rather than a default, since neither is "the" users
 * chart.
 *
 * THEY TAKE THE PAYLOAD, THEY DO NOT FETCH IT. Design §6: "A chart never
 * fetches; it receives already-validated data." `RunDetail` runs the one
 * `usersQuery` (Task 10) and hands the same response to both — one request, two
 * charts, exactly as `/stats` feeds ③ and ④.
 *
 * `useMemo` on each transform because `Chart`'s option effect depends on `data`
 * by identity: a fresh object every render would re-issue `setOption` on every
 * render, including on every React Query background refetch.
 */
export interface UsersChartProps {
  readonly users: UsersResponse;
  /**
   * The ECharts `connect` group Task 10 assigns to the time-axis charts, so
   * hovering requests/s moves the pointer here too. That shared crosshair is
   * WHY active users is its own chart rather than a second y-axis on
   * requests/s: §22.4 forbids dual axes, and the crosshair is what recovers the
   * "read these two together" affordance the dual axis was buying (PRD §13.2's
   * deliberate encoding change).
   */
  readonly group?: string;
}

/** ⑦ — the concurrency curve. Plots `maxConcurrent`; see `toConcurrentUsers`. */
export function ConcurrentUsersChart({ users, group }: UsersChartProps) {
  const data = useMemo(() => toConcurrentUsers(users), [users]);

  return (
    <Chart
      id="concurrent-users"
      title="Concurrent users over time"
      data={data}
      group={group}
      // Users, not users per second. The two charts' axes are named apart
      // deliberately: they are drawn one above the other, and identical axis
      // labels on two lines of similar shape is how a reader ends up believing
      // they are the same measurement.
      yAxis={{ name: 'Users' }}
      // Matching the axis above it, for the same reason that axis is named
      // apart from the arrival rate's: the tooltip is where the two charts are
      // most easily confused, since it is read without the axis in view.
      unit="users"
    />
  );
}

/** ⑦ᵇ — the arrival rate. Plots `started` per second; see `toUserStartRate`. */
export function UserStartRateChart({ users, group }: UsersChartProps) {
  const data = useMemo(() => toUserStartRate(users), [users]);

  return (
    <Chart
      id="user-start-rate"
      title="Users started per second"
      data={data}
      group={group}
      yAxis={{ name: 'Users/s' }}
      unit="users/s"
    />
  );
}
