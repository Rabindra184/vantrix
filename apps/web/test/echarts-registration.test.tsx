import { cleanup, render } from '@testing-library/react';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { ComponentModel } from 'echarts/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Chart from '../src/charts/Chart.js';
import type { ChartData } from '../src/charts/types.js';

/**
 * ═══ EVERY COMPONENT `Chart` EMITS IS ONE `echarts.ts` REGISTERS ═══
 *
 * ECharts DISCARDS an option whose component (or series type) was never passed
 * to `echarts.use`, silently: no throw, and nothing in the console at the point
 * of use. That has now shipped three times — the scatter series (an empty frame
 * over a full data table), the time-window slider (a chart with no slider under
 * it), and AC-STAT-4's warm-up `markArea`, which `Chart` built on every
 * elapsed-time chart while no run ever showed its warm-up.
 *
 * `Chart.test.tsx` could not see the third, and cannot see the next one: it
 * MOCKS `echarts.ts`, so it proves the option `Chart` hands the renderer and
 * nothing about whether the renderer was told how to draw it. This file closes
 * the gap at the seam rather than per feature:
 *
 *   - the REGISTRY is real. `vi.mock` keeps the real `echarts.ts` (so its
 *     `echarts.use([...])` runs against the real `echarts/core`) and replaces
 *     only `init`/`connect`, so the options `Chart` emits can be captured
 *     while `ComponentModel` answers what is actually registered;
 *   - the UNIVERSE is ECharts' own. Which option keys name a component is read
 *     from a separate Node process that imports the full `echarts` barrel —
 *     never from a list in this file, which would go stale the day `Chart`
 *     reached for a component nobody had written down. A separate PROCESS,
 *     because importing the barrel here would register everything and make
 *     every assertion below vacuously true;
 *   - the OPTIONS are `Chart`'s own, across the props that add a component (a
 *     brush, a warm-up band, a legend, a scatter, a pie), with a floor on the
 *     keys collected so a rendering that stopped exercising a branch fails
 *     instead of passing over less.
 *
 * A component is checked at its SUBTYPE too where the option names one
 * (`legend: { type: 'scroll' }`, `dataZoom: [{ type: 'slider' }]`, an axis's
 * `type`). The main type alone is not enough: `hasClass('dataZoom')` is true
 * once the SLIDER is registered, so a `dataZoom` of `type: 'inside'` — the
 * variant `echarts.ts` deliberately leaves out — would pass a main-type check
 * and still be discarded.
 *
 * What it does not see: an option nested deeper than a series (no component
 * is declared there today), and a component emitted by a prop combination not
 * rendered below. The vacuity floor is what keeps the second honest — add the
 * new branch's key to it when a component is added.
 */

const { initSpy, setOptionSpy } = vi.hoisted(() => ({
  initSpy: vi.fn(),
  setOptionSpy: vi.fn(),
}));

vi.mock('../src/charts/echarts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/charts/echarts.js')>();
  return {
    echarts: {
      ...real.echarts,
      init: initSpy,
      connect: vi.fn(),
    },
  };
});

initSpy.mockImplementation(() => ({
  group: undefined as string | undefined,
  setOption: setOptionSpy,
  dispose: vi.fn(),
  resize: vi.fn(),
  on: vi.fn(),
  getOption: () => ({ dataZoom: [{}] }),
}));

afterEach(cleanup);

/**
 * `getClass` is on the class at runtime (ECharts' class registry, the one
 * `hasClass` reads) but absent from its typings, so it is named here once.
 */
const registry = ComponentModel as unknown as { getClass(main: string, sub: string): unknown };

/** Every component main type ECharts 6 knows, from a process that registered them all. */
function componentUniverse(): readonly string[] {
  // The test file's own path, not `process.cwd()` (which is `apps/web` under an
  // editor's vitest and the workspace root under `pnpm test:unit`), and not
  // `import.meta.url`, which is not a file: URL under jsdom. `echarts` must
  // resolve from `apps/web`, the package that depends on it.
  const webDir = join(dirname(expect.getState().testPath ?? ''), '..');
  const out = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const core = await import('echarts/core'); await import('echarts');" +
        'console.log(JSON.stringify(core.ComponentModel.getAllClassMainTypes()));',
    ],
    { cwd: webDir, encoding: 'utf8' },
  );
  return JSON.parse(out) as string[];
}

const timeSeries: ChartData = {
  series: [
    { name: 'p50', data: [[0, 1], [1000, 2], [2000, 3]] },
    { name: 'p95', data: [[0, 2], [1000, 3], [2000, 4]] },
  ],
  axisLabels: [],
  columns: ['Time', 'p50', 'p95'],
  rows: [{ label: '0', values: [1, 2] }],
};

const categorical: ChartData = {
  series: [{ name: 'Requests', data: [5, 7] }],
  axisLabels: ['OK', 'KO'],
  columns: ['Outcome', 'Requests'],
  rows: [{ label: 'OK', values: [5] }],
};

/** Each prop combination that adds a component to the option. */
function renderEveryBranch(): void {
  const elapsed = { type: 'value', tickUnit: 'ms-as-s', warmupMs: 1000 } as const;
  render(<Chart id="line" title="Response time" data={timeSeries} xAxis={elapsed} group="g" />);
  render(
    <Chart id="brush" title="Window" data={timeSeries} xAxis={elapsed} navigator
      brush={{ value: null, onChange: () => undefined }} />,
  );
  render(<Chart id="scatter" title="Scatter" kind="scatter" data={timeSeries} />);
  render(<Chart id="bar" title="Bar" kind="bar" data={categorical} />);
  render(<Chart id="pie" title="Pie" kind="pie" data={categorical} />);
}

/** `key` or `key.subtype` for one emitted component value, which may be an array of them. */
function typesOf(key: string, value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  const subtypes = entries
    .map((entry) => (entry !== null && typeof entry === 'object' ? (entry as { type?: unknown }).type : undefined))
    .filter((type): type is string => typeof type === 'string');
  return subtypes.length === 0 ? [key] : subtypes.map((type) => `${key}.${type}`);
}

function emitted(): { components: Set<string>; seriesTypes: Set<string> } {
  const components = new Set<string>();
  const seriesTypes = new Set<string>();
  for (const [option] of setOptionSpy.mock.calls as [Record<string, unknown>][]) {
    for (const key of Object.keys(option)) {
      if (option[key] !== undefined && key !== 'series') for (const t of typesOf(key, option[key])) components.add(t);
    }
    for (const series of (option['series'] ?? []) as Record<string, unknown>[]) {
      if (typeof series['type'] === 'string') seriesTypes.add(series['type']);
      for (const key of Object.keys(series)) if (series[key] !== undefined) components.add(key);
    }
  }
  return { components, seriesTypes };
}

describe('the ECharts registry against what Chart emits', () => {
  it('registers every component an option of Chart names', () => {
    renderEveryBranch();
    const universe = new Set(componentUniverse());
    const { components } = emitted();
    const used = [...components].filter((key) => universe.has(key.split('.')[0]!));

    const unregistered = used.filter((key) => {
      const [main, sub] = key.split('.') as [string, string | undefined];
      return sub === undefined ? !ComponentModel.hasClass(main) : !registry.getClass(main, sub);
    });
    expect(unregistered, 'emitted by Chart but never passed to echarts.use in charts/echarts.ts').toEqual([]);
    // The floor, checked SECOND so a missing registration reports as one: these
    // are the branches rendered above. A key missing here means a rendering
    // stopped reaching its branch, and the check above passed over less than
    // it claims.
    expect(used).toEqual(
      expect.arrayContaining([
        'grid', 'xAxis.value', 'xAxis.category', 'yAxis.value', 'tooltip', 'legend.scroll',
        'dataZoom.slider', 'markArea',
      ]),
    );
  });

  it('registers every series type Chart draws', () => {
    renderEveryBranch();
    const { seriesTypes } = emitted();
    expect([...seriesTypes].sort()).toEqual(['bar', 'line', 'pie', 'scatter']);
    const unregistered = [...seriesTypes].filter((type) => !registry.getClass('series', type));
    expect(unregistered, 'series types Chart emits that charts/echarts.ts never registers').toEqual([]);
  });
});
