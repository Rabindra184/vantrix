import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TimeBrush from '../src/charts/TimeBrush';
import { RATE_ROLES } from '../src/charts/transforms/rates';
import { CATEGORICAL } from '../src/charts/theme';
import fixture from './fixtures/reference-run.json';

/**
 * THE JOIN BETWEEN THE TRANSFORM AND THE AXIS, which is where this component
 * was broken and which neither side's own tests could see.
 *
 * `transforms.rates.test.ts` proves the millisecond form carries [ms, rate]
 * pairs. `Chart.test.tsx` proves the brush reports its handles in the axis'
 * own units. Both were true while this component was wrong, because it drew
 * the CATEGORY form on a VALUE axis: ECharts then mapped each scalar onto both
 * axes, the strip plotted requests/s against requests/s as a straight 45° line,
 * and every drag committed a window in rate values read as milliseconds — a
 * drag across the first third of a 63 s run produced `?from=0&to=7`.
 *
 * So the assertion here is deliberately about the ONE fact that spans the two:
 * the numbers this component hands the renderer for x are elapsed
 * milliseconds, on the axis it declares. Nothing about what ECharts then drew
 * — that is `run-charts.spec.ts`'s, in a real browser.
 */

const { initSpy, setOptionSpy } = vi.hoisted(() => ({
  initSpy: vi.fn(),
  setOptionSpy: vi.fn(),
}));

vi.mock('../src/charts/echarts.js', () => ({
  echarts: { init: initSpy, connect: vi.fn() },
}));

/** The last option object `Chart` handed to `setOption`. */
function lastOption(): Record<string, unknown> {
  expect(setOptionSpy.mock.calls.length).toBeGreaterThan(0);
  return setOptionSpy.mock.calls.at(-1)![0] as Record<string, unknown>;
}

const RUN = '2b0f2bf2-6c1e-4c3f-9d6a-1f2f1a6d4c11';
const buckets = fixture.series.buckets;

beforeEach(() => {
  initSpy.mockReset();
  setOptionSpy.mockReset();
  initSpy.mockImplementation(() => ({
    group: undefined as string | undefined,
    setOption: setOptionSpy,
    dispose: vi.fn(),
    resize: vi.fn(),
    on: vi.fn(),
    getOption: vi.fn(),
  }));

  vi.stubGlobal('fetch', (input: RequestInfo) =>
    String(input).includes('/series')
      ? Promise.resolve(new Response(JSON.stringify(fixture.series), { status: 200 }))
      : Promise.resolve(new Response('{}', { status: 500 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderBrush(
  props: { onChange?: (next: unknown) => void; window?: unknown } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TimeBrush
        runId={RUN}
        runDurationMs={63_161}
        window={(props.window ?? null) as never}
        onChange={(props.onChange ?? (() => undefined)) as never}
      />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(setOptionSpy).toHaveBeenCalled());
}

describe('TimeBrush — the strip the window is dragged on', () => {
  it('draws against elapsed MILLISECONDS, the units its brush commits in', async () => {
    await renderBrush();

    const series = lastOption()['series'] as { data: readonly (readonly [number, number])[] }[];
    const x = series[0]!.data.map((point) => point[0]);

    // Computed from the payload: a re-capture moves every one of these.
    expect(x).toEqual(buckets.map((b) => b.startOffsetMs));
  });

  it('spans the whole run, so the strip is a map of all of it', async () => {
    await renderBrush();

    const series = lastOption()['series'] as { data: readonly (readonly [number, number])[] }[];
    const x = series[0]!.data.map((point) => point[0]);

    // The failure this replaces drew x over the RATE's range — 0 to about 21 —
    // which is why both axes read 0..21 and the line came out at 45°.
    expect(Math.min(...x)).toBe(buckets[0]!.startOffsetMs);
    expect(Math.max(...x)).toBe(buckets.at(-1)!.startOffsetMs);
    expect(Math.max(...x)).toBeGreaterThan(60_000);
  });

  it('declares the value axis those pairs require', async () => {
    await renderBrush();
    expect(lastOption()['xAxis']).toMatchObject({ type: 'value' });
  });

  /**
   * ═══ THE NAME DESCRIBES WHAT THE READER SEES, THE DATA STAYS IN ms ═══
   *
   * This replaces an assertion that the name read `(ms)`, which was right while
   * the axis was labelled in raw milliseconds and is now wrong: the ticks are
   * relabelled in seconds so the strip agrees with its own From/To fields and
   * with the six charts under it, all of which are in elapsed seconds.
   *
   * The protection that assertion gave — the name must not lie about the axis —
   * is kept, and widened, by pinning the whole chain in one place: the plotted
   * x is still milliseconds (the brush contract), the formatter is what turns
   * those into seconds, and the name is in seconds because that is what ends up
   * under the ticks. A change to any one of the three without the others fails
   * here.
   */
  it('labels that axis in seconds while still plotting milliseconds', async () => {
    await renderBrush();

    const axis = lastOption()['xAxis'] as {
      name: string;
      axisLabel: { formatter?: (value: number) => string };
    };

    // The name the reader sees, and the units the ticks are in.
    expect(axis.name).toMatch(/\(s\)/);
    expect(axis.name).not.toMatch(/\(ms\)/);

    // The formatter is what makes that true, so it has to exist and convert.
    expect(axis.axisLabel.formatter).toBeTypeOf('function');
    expect(axis.axisLabel.formatter!(20_000)).toBe('20');
    expect(axis.axisLabel.formatter!(63_161)).toBe('63');

    // And the DATA underneath is untouched — milliseconds, which is what the
    // slider reports and what `commit` writes to the URL.
    const series = lastOption()['series'] as { data: readonly (readonly [number, number])[] }[];
    expect(series[0]!.data.map((point) => point[0])).toEqual(
      buckets.map((b) => b.startOffsetMs),
    );
  });

  /**
   * ═══ THE STRIP AND THE CHART BELOW IT MUST SPEAK ONE COLOUR LANGUAGE ═══
   *
   * `RATE_ROLES` is `['neutral', 'passed', 'failed']` and exists so All/OK/KO
   * mean here what they mean on the donut and the distribution. This component
   * consumed the same transform as `RatesChart` but never passed the roles, so
   * ECharts fell back to the categorical palette: the strip drew All/OK/KO as
   * indigo/teal/violet while `RatesChart` drew them as grey/green/red, on the
   * same page, for the same three series — and KO arrived in a hue that
   * `rates.ts` reserves for "neither outcome".
   *
   * Asserted as the ROLES, not as hex: the roles are the claim, and the hex
   * behind them is `theme.ts`'s to change.
   */
  it('draws All/OK/KO in the status colours, not the categorical palette', async () => {
    await renderBrush();

    const series = lastOption()['series'] as { name: string }[];
    expect(series.map((s) => s.name)).toEqual(['All', 'OK', 'KO']);

    // `Chart` maps `roles` through the live token table, so what lands in the
    // option is the resolved colour per series, in role order. Three distinct
    // values, and none of them a categorical hue.
    const colors = lastOption()['color'] as string[];
    expect(colors).toHaveLength(RATE_ROLES.length);
    expect(new Set(colors).size).toBe(3);
    for (const categorical of CATEGORICAL) {
      expect(colors).not.toContain(categorical);
    }
  });
});

/**
 * REVIEW C08 — AN INVALID RANGE MUST NOT BROADEN THE SCOPE.
 *
 * `apply()` answered every unparseable, negative or reversed input with
 * `onChange(null)`, which is the signal for "the whole run". So typing
 * From=30 To=10 — a mistake — silently WIDENED the analysis instead of
 * refusing it, and every figure on the page then described more data than the
 * reader believed they had selected. A reset is the one response an input
 * error must never produce here.
 *
 * The previously applied window has to survive too: a typo in one field
 * cannot be allowed to discard a selection the reader already made.
 */
describe('TimeBrush — an invalid range is refused, never widened', () => {
  const WINDOW = { fromMs: 10_000, toMs: 30_000, bucketWidthMs: 0 };

  it('refuses a reversed range instead of resetting to the whole run', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    await renderBrush({ onChange });

    await user.clear(screen.getByTestId('window-from'));
    await user.type(screen.getByTestId('window-from'), '30');
    await user.clear(screen.getByTestId('window-to'));
    await user.type(screen.getByTestId('window-to'), '10');
    await user.click(screen.getByTestId('window-apply'));

    expect(onChange).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('refuses text that is not a number', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    await renderBrush({ onChange });

    await user.clear(screen.getByTestId('window-to'));
    await user.type(screen.getByTestId('window-to'), 'abc');
    await user.click(screen.getByTestId('window-apply'));

    expect(onChange).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('keeps the reader’s typing so the mistake can be corrected in place', async () => {
    const user = userEvent.setup();
    await renderBrush({ onChange: vi.fn() });

    await user.clear(screen.getByTestId('window-from'));
    await user.type(screen.getByTestId('window-from'), '30');
    await user.clear(screen.getByTestId('window-to'));
    await user.type(screen.getByTestId('window-to'), '10');
    await user.click(screen.getByTestId('window-apply'));

    expect(screen.getByTestId('window-from')).toHaveValue('30');
    expect(screen.getByTestId('window-to')).toHaveValue('10');
  });

  /** The already-applied selection must survive a typo — refusing is only
   *  safe if it leaves the previous answer standing. */
  it('leaves an applied window in place when the next input is invalid', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    await renderBrush({ onChange, window: WINDOW });

    await user.clear(screen.getByTestId('window-to'));
    await user.type(screen.getByTestId('window-to'), '5');
    await user.click(screen.getByTestId('window-apply'));

    expect(onChange).not.toHaveBeenCalled();
  });

  /** "Whole run" is still reachable — the fix must refuse bad input without
   *  removing the deliberate way to widen. */
  it('still clears to the whole run on the explicit control', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    await renderBrush({ onChange, window: WINDOW });

    await user.click(screen.getByTestId('window-clear'));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('accepts a valid range, and drops the error once it does', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    await renderBrush({ onChange });

    await user.clear(screen.getByTestId('window-from'));
    await user.type(screen.getByTestId('window-from'), '30');
    await user.clear(screen.getByTestId('window-to'));
    await user.type(screen.getByTestId('window-to'), '10');
    await user.click(screen.getByTestId('window-apply'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.clear(screen.getByTestId('window-to'));
    await user.type(screen.getByTestId('window-to'), '40');
    await user.click(screen.getByTestId('window-apply'));

    expect(onChange).toHaveBeenCalledWith({
      fromMs: 30_000,
      toMs: 40_000,
      bucketWidthMs: 0,
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /* ====================================================================== *
   * REVIEW M01 — COLLAPSED, BUT NEVER HIDING AN APPLIED WINDOW
   * ====================================================================== */

  /**
   * ═══ WHY THIS CONTROL IS A DISCLOSURE NOW ═══
   *
   * Measured at 1440x900 it ran 332px, which put the run's own totals at y937
   * and their VALUES at y980 — eighty pixels below the fold, on the page a
   * reader opens to read four numbers. M01 asks for failure, p95, error rate
   * and throughput inside that first screen. Closed it is 44px and the totals
   * begin at y649.
   *
   * ═══ AND WHY CLOSING IT IS ONLY SAFE BECAUSE OF THE CASES BELOW ═══
   *
   * A reader looking at a tenth of a run with nothing on screen admitting it
   * is the one failure this control must never cause — `CompactWindowNotice`
   * exists for exactly that reason one viewport down. So the disclosure opens
   * itself whenever a window is applied, and says which window from the
   * outside when it is shut.
   *
   * The EFFECT is the half that is easy to get wrong: `RunShell` does not
   * remount between tabs, so a window arriving from a URL — or a reader
   * clearing and re-applying one — reaches a component that is already
   * mounted and already closed. Initial state alone would leave that narrowing
   * behind a shut control.
   */
  const details = () =>
    document.querySelector('[data-testid="time-brush"] details') as HTMLDetailsElement;

  it('starts closed on a run nobody has narrowed', async () => {
    await renderBrush();
    expect(details().open).toBe(false);
    expect(screen.getByTestId('time-window-toggle')).toHaveTextContent(/whole run/i);
  });

  /**
   * PINS THE PROPERTY, NOT THE MECHANISM, and that is measured rather than
   * assumed: `TimeBrush` both seeds its state from `window` and re-opens in an
   * effect, and removing EITHER leaves this case green, because the effect
   * runs on mount too. Verified by deleting each in turn.
   *
   * They are kept as deliberate redundancy with different jobs — the seed so
   * the first PAINT is already open on a narrowed URL rather than flickering
   * shut-then-open, the effect for windows that arrive at a component already
   * mounted. Only the effect is separately pinned, by the transition case
   * below; the seed's job is a frame nothing in jsdom can observe.
   */
  it('is open when the run arrives already narrowed', async () => {
    await renderBrush({ window: { fromMs: 10_000, toMs: 30_000 } });
    expect(details().open).toBe(true);
  });

  /**
   * THE TRANSITION, not either endpoint. Mounting each state separately cannot
   * catch this: the defect lives in a window arriving at a component that is
   * already mounted and already shut, which is what a tab change or a pasted
   * URL produces. Same shape as the live-to-terminal cases CLAUDE.md records
   * for `RunTelemetry` and `RunCompare`.
   */
  it('opens itself when a window arrives after it is already closed', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <TimeBrush runId={RUN} runDurationMs={63_161} window={null} onChange={() => undefined} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(setOptionSpy).toHaveBeenCalled());
    expect(details().open).toBe(false);

    view.rerender(
      <QueryClientProvider client={client}>
        <TimeBrush
          runId={RUN}
          runDurationMs={63_161}
          /* `bucketWidthMs` is REQUIRED on `Window` and `renderBrush` hides
             that behind an `as never`; this case builds the prop by hand, so
             the compiler sees it. The suite was green while it was missing —
             vitest does not typecheck, which is why the gate's first command
             is the only thing that catches a test constructing a prop wrong. */
          window={{ fromMs: 10_000, toMs: 30_000, bucketWidthMs: 1_000 }}
          onChange={() => undefined}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(details().open).toBe(true));
  });

  /** Shut, it still says which stretch the numbers below describe. */
  it('names the applied window from the outside', async () => {
    await renderBrush({ window: { fromMs: 10_000, toMs: 30_000 } });
    expect(screen.getByTestId('time-window-toggle')).toHaveTextContent('10s–30s');
    expect(screen.getByTestId('time-window-toggle').textContent ?? '').not.toMatch(/whole run/i);
  });
});
