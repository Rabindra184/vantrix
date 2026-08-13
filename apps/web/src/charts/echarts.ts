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
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  AxisPointerComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

echarts.use([
  // The three mark types §13.2 needs: bars (indicators, distribution), lines
  // (concurrent users, arrival rate, percentiles, requests/s, responses/s),
  // and pie (the request-count donut ④).
  BarChart,
  LineChart,
  PieChart,

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

  // SVG, NOT canvas. Marks become real DOM nodes, which is what lets a
  // Playwright spec assert on what was actually drawn (Task 10's crosshair
  // test reads axis-pointer elements out of the DOM) instead of on pixels.
  SVGRenderer,
]);

export { echarts };
