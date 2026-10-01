/**
 * THE ONE CROSSHAIR. Every chart whose x-axis is elapsed time carries this
 * `group`, and `Chart` calls `echarts.connect` with it, so hovering one moves
 * the pointer on all of them — the "read these together" affordance §22.4's
 * ban on dual axes would otherwise cost (PRD Appendix A). Both run pages draw
 * time charts now, so the string lives here rather than in either.
 */
export const RUN_TIME_GROUP = 'run-time';
