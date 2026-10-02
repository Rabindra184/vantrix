import type { Slot } from './payload';

/**
 * The two charts the Summary and the Report both draw, spelled once.
 *
 * A `Slot`'s title is what `Payload` prints for a figure that is still loading
 * or failed to load — and what `Chart` prints as the real figure's own title
 * once it arrives, which is a second place that must say the same words. Two
 * pages drawing one chart with two spellings of its title is a reader who sees
 * the figure rename itself between Summary and Report.
 */
export const REQUESTS_AND_RESPONSES: Slot = { id: 'requests-and-responses', title: 'Requests and responses per second over time' };
export const PERCENTILES: Slot = { id: 'percentiles', title: 'Response time percentiles over time' };
