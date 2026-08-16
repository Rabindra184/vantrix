/**
 * The ONLY module in this app that imports from `echarts/core`.
 *
 * ECharts ships every chart type and every component in one barrel; importing
 * `'echarts'` anywhere pulls the whole library into the bundle. Registration is
 * centralised here so that the bundle cost of adding a new chart type is one
 * visible line in one diff, reviewable on its own, rather than a
 * hard-to-notice import in the eighth chart component.
 *
 * If a chart needs something not registered below, add it HERE — never reach
 * into `echarts/charts` from a component.
 */
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import {
  AxisPointerComponent,
  DataZoomSliderComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

echarts.use([
  // The four mark types §13.2 and §13.3 need: bars (indicators, distribution),
  // lines (concurrent users, arrival rate, percentiles, requests/s,
  // responses/s), pie (the request-count donut ④), and scatter (⑨, response
  // time against global requests/s — the one chart that lives ONLY on a
  // request's own page, which is why it outlived its omission here).
  //
  // AN UNREGISTERED SERIES TYPE FAILS SILENTLY. ECharts discards the series,
  // logs to the console and draws the grid and axes anyway — so ⑨ shipped as an
  // empty frame with a full data table beneath it, past a `<figure>` visibility
  // check and a `path` count that the axis line alone satisfied. Anything added
  // below needs an e2e assertion about its MARKS to be load-bearing; see
  // `request-detail.spec.ts`'s scatter test.
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,

  GridComponent,
  LegendComponent,
  TooltipComponent,
  // Required for `echarts.connect`: the shared crosshair across the FIVE
  // time-axis charts — concurrent users, users started per second, the
  // percentile bands, requests/s and responses/s — is an axis pointer, and
  // without this component the charts connect but nothing is drawn to link
  // them. (Five, not four: `user-start-rate` is on the same elapsed-seconds
  // axis as the rest, takes the same `group`, and `run-charts.spec.ts` pins
  // all five.)
  AxisPointerComponent,

  // The time-window scrubber (`Chart`'s `brush` prop). SLIDER ONLY — the
  // `inside` variant would add wheel-and-pinch zoom on the plot itself, giving
  // one window two gestures that can disagree, and the full `DataZoomComponent`
  // barrel pulls in both.
  //
  // This one cost an afternoon to the exact failure the note above describes:
  // an unregistered component makes ECharts DISCARD the option silently, so the
  // strip rendered as a perfectly ordinary chart with no slider under it and
  // nothing in the console at the point of use. The probe that found it counted
  // `<rect>` elements in the drawn SVG and got 1.
  DataZoomSliderComponent,

  // SVG, NOT canvas. Marks become real DOM nodes, which is what lets a
  // Playwright spec assert on what was actually drawn (Task 10's crosshair
  // test reads axis-pointer elements out of the DOM) instead of on pixels.
  SVGRenderer,
]);

export { echarts };
