/**
 * THE ONE CROSSHAIR. Every time-series chart on ONE run's clock carries this
 * `group`, and `Chart` calls `echarts.connect` with it, so hovering any one of
 * them moves the axis pointer on all of them.
 *
 * That linkage is not a nicety, it is the PRD's deliberate encoding change:
 * Gatling overlays active users on requests/s as a second y-axis, §22.4 forbids
 * dual axes outright, and Appendix A records the split as information parity
 * precisely BECAUSE the shared crosshair recovers the "read these two together"
 * affordance the dual axis was buying. Break the connection and the charts stop
 * being one reading — which is what the e2e crosshair spec exists to catch.
 *
 * ONE SPELLING, imported by every one of those charts and by the pages that
 * hand it down (the users charts take it as a `group` prop). It used to be a
 * string literal in each file; both run pages draw time charts now, so it lives
 * here rather than in either.
 *
 * Outside it, deliberately: the compare overlay (several runs' clocks), the
 * trends charts (their x is runs) and the percentile distribution (its x is a
 * percentile) each say why where they are drawn, and the time-window strip is
 * the control a reader drags rather than a reading.
 */
export const RUN_TIME_GROUP = 'run-time';
