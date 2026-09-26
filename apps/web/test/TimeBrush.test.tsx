import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TimeBrush from '../src/charts/TimeBrush';
import { RATE_ROLES } from '../src/charts/transforms/rates';
import { CATEGORICAL } from '../src/charts/theme';
import { TimeAxisProvider } from '../src/charts/TimeAxisContext';
import { formatDuration } from '../src/routes/format';
import { presetWindow, stepWindow, WINDOW_PRESETS, WINDOW_STEPS } from '../src/routes/window';
import { TIME_AXIS_STORAGE_KEY } from '../src/timeAxisPreference';
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
  props: {
    onChange?: (next: unknown) => void;
    window?: unknown;
    applied?: unknown;
    /** Present to render under a run's clock; absent renders outside any provider. */
    anchor?: string | null;
    runDurationMs?: number;
    runActivityMs?: number | null;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const brush = (
    <TimeBrush
      runId={RUN}
      runDurationMs={props.runDurationMs ?? 63_161}
      runActivityMs={props.runActivityMs}
      window={(props.window ?? null) as never}
      applied={(props.applied ?? null) as never}
      onChange={(props.onChange ?? (() => undefined)) as never}
    />
  );
  render(
    <QueryClientProvider client={client}>
      {props.anchor === undefined ? brush : <TimeAxisProvider anchor={props.anchor}>{brush}</TimeAxisProvider>}
    </QueryClientProvider>,
  );
  await waitFor(() => expect(setOptionSpy).toHaveBeenCalled());
}

/** Pins the process zone; see `format.test.ts` for why the flip is asserted. */
async function inZone(zone: string, body: () => Promise<void>): Promise<void> {
  const original = process.env.TZ;
  try {
    process.env.TZ = zone;
    await body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
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
   * This replaces an assertion that the name read `(s)`, which was right while
   * the ticks were bare seconds and is wrong now: they read `HH:MM:SS`,
   * Gatling Enterprise's Offset notation, under a name `Chart` decides from
   * the viewer's time mode.
   *
   * The protection that assertion gave, that the name must not lie about the
   * axis, is kept by pinning the whole chain in one place: the plotted x is
   * still milliseconds (the brush contract), the formatter is what turns
   * those into clock time, and the name says elapsed because that is what ends
   * up under the ticks. A change to any one of the three without the others
   * fails here.
   */
  it('labels that axis as elapsed clock time while still plotting milliseconds', async () => {
    await renderBrush();

    const axis = lastOption()['xAxis'] as {
      name: string;
      axisLabel: { formatter?: (value: number) => string };
    };

    // The name the reader sees, and the units the ticks are in.
    expect(axis.name).toBe('Elapsed');

    // The formatter is what makes that true, so it has to exist and convert.
    expect(axis.axisLabel.formatter).toBeTypeOf('function');
    expect(axis.axisLabel.formatter!(20_000)).toBe('00:00:20');
    expect(axis.axisLabel.formatter!(63_161)).toBe('00:01:03');

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

  /** Shut, the always-visible range line still says which stretch the numbers describe. */
  it('names the applied window from the outside', async () => {
    await renderBrush({ window: { fromMs: 10_000, toMs: 30_000 } });
    const range = screen.getByTestId('window-range');
    // No provider, so no anchor: the ends are elapsed clock time.
    expect(range).toHaveTextContent('00:00:10 → 00:00:30');
    expect(range).toHaveTextContent('20s');
    expect(screen.getByTestId('time-window-toggle').textContent ?? '').not.toMatch(/whole run/i);
  });
});

/* ====================================================================== *
 * GATLING ENTERPRISE'S TIME CONTROLS (docs/superpowers/specs/2026-09-26-…)
 * ====================================================================== */

describe('TimeBrush — Gatling Enterprise’s time controls', () => {
  // 17:12:09 in Asia/Kolkata: the start of the run Gatling was measured on.
  const ANCHOR = '2026-08-15T11:42:09.000Z';
  const WHOLE = { fromMs: 0, toMs: 63_161 };
  const RESOLUTION = fixture.series.bucketWidthMs;
  const kolkataTook = () => expect(new Date('2026-08-15T00:00:00Z').getHours()).toBe(5);

  afterEach(() => {
    localStorage.removeItem(TIME_AXIS_STORAGE_KEY);
  });

  it('states the window as a range to the second, in the reader’s zone', async () => {
    await inZone('Asia/Kolkata', async () => {
      kolkataTook();
      await renderBrush({ anchor: ANCHOR, window: { fromMs: 30_000, toMs: 90_000 }, runDurationMs: 120_000 });
      const range = screen.getByTestId('window-range');
      // Gatling's 17:12:39 → 17:13:39, in whichever hour cycle the locale uses.
      expect(range).toHaveTextContent(/:12:39/);
      expect(range).toHaveTextContent(/:13:39/);
      expect(range).toHaveTextContent('GMT+5:30');
      expect(range).toHaveTextContent('60s');
    });
  });

  it('states the snapped window once a response reports one, held to the run', async () => {
    await renderBrush({
      window: { fromMs: 10_300, toMs: 63_161 },
      applied: { fromMs: 10_000, toMs: 64_000, bucketWidthMs: 1_000 },
    });
    // The snap reached a bucket past the run's end; the line stops at it.
    expect(screen.getByTestId('window-range')).toHaveTextContent('00:00:10 → 00:01:03');
  });

  it('offers Gatling’s presets, and one longer than the run is the whole run', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    await renderBrush({ onChange, window: { fromMs: 10_000, toMs: 30_000 } });

    await user.click(screen.getByTestId('window-range'));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(WINDOW_PRESETS.map((p) => p.label));

    await user.click(screen.getByRole('menuitem', { name: 'Last 5 Minutes' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('measures a preset back from the end of a long run', async () => {
    const FOUR_HOURS = 4 * 3_600_000;
    const onChange = vi.fn();
    const user = userEvent.setup();
    await renderBrush({ onChange, runDurationMs: FOUR_HOURS });

    await user.click(screen.getByTestId('window-range'));
    await user.click(await screen.findByRole('menuitem', { name: 'Last 15 Minutes' }));

    expect(onChange).toHaveBeenCalledWith(presetWindow(15 * 60_000, FOUR_HOURS, RESOLUTION));
    expect(onChange.mock.calls[0]![0]).not.toBeNull();
  });

  it('names the reader’s zone in the Datetime option, taken at the run’s start', async () => {
    await inZone('Asia/Kolkata', async () => {
      kolkataTook();
      await renderBrush({ anchor: ANCHOR });
      const select = screen.getByTestId('time-axis-mode') as HTMLSelectElement;
      expect([...select.options].map((option) => option.textContent)).toEqual([
        'Offset',
        `Datetime (${Intl.DateTimeFormat().resolvedOptions().timeZone} - GMT+5:30)`,
      ]);
      expect(select.value).toBe('offset');
    });
  });

  it('labels the Datetime option for the run’s own season, not today’s', async () => {
    // New York is GMT-4 in July and GMT-5 in January. "Today" is pinned to
    // January, so an offset taken now rather than at the run's start reads -5.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
      await inZone('America/New_York', async () => {
        expect(new Date('2026-07-01T12:00:00Z').getHours()).toBe(8);
        await renderBrush({ anchor: '2026-07-01T16:00:00.000Z' });
        const select = screen.getByTestId('time-axis-mode') as HTMLSelectElement;
        expect(select.options[1]!.textContent).toBe(
          `Datetime (${Intl.DateTimeFormat().resolvedOptions().timeZone} - GMT-4)`,
        );
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches every axis beneath it to the wall clock, and remembers', async () => {
    await inZone('Asia/Kolkata', async () => {
      kolkataTook();
      const user = userEvent.setup();
      await renderBrush({ anchor: ANCHOR });

      await user.selectOptions(screen.getByTestId('time-axis-mode'), 'datetime');

      await waitFor(() =>
        expect((lastOption()['xAxis'] as { name: string }).name).toBe('Time (GMT+5:30)'),
      );
      expect(localStorage.getItem(TIME_AXIS_STORAGE_KEY)).toBe('datetime');
    });
  });

  it('offers Datetime only to a run that recorded its start, and says why not', async () => {
    await renderBrush({ anchor: null });
    const datetime = [...(screen.getByTestId('time-axis-mode') as HTMLSelectElement).options].find(
      (option) => option.value === 'datetime',
    )!;
    expect(datetime.disabled).toBe(true);
    expect(screen.getByTestId('time-axis-no-anchor')).toBeVisible();
  });

  it('heads the navigator with its resolution and the run’s Duration', async () => {
    await renderBrush({ runActivityMs: 62_136 });
    expect(screen.getByTestId('window-resolution')).toHaveTextContent(
      `Resolution: ${formatDuration(RESOLUTION)}`,
    );
    // `activityMs`, the number the run header calls Duration, never the
    // series span, which is a second longer on this run.
    expect(screen.getByTestId('window-duration')).toHaveTextContent('Duration: 62s');
  });

  it('offers only Zoom in while the whole run is shown, each control named in Gatling’s words', async () => {
    await renderBrush();
    const live = WINDOW_STEPS.filter(
      ({ step }) => !(screen.getByTestId(`window-step-${step}`) as HTMLButtonElement).disabled,
    );
    expect(live.map(({ step }) => step)).toEqual(['zoom-in']);
    for (const { step, label } of WINDOW_STEPS) {
      expect(screen.getByTestId(`window-step-${step}`)).toHaveAccessibleName(label);
      expect(screen.getByTestId(`window-step-${step}`)).toHaveAttribute('title', label);
    }
  });

  it('commits the window a control moves to, on the navigator’s buckets', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    await renderBrush({ onChange });
    await user.click(screen.getByTestId('window-step-zoom-in'));
    expect(onChange).toHaveBeenLastCalledWith(stepWindow(WHOLE, 'zoom-in', WHOLE.toMs, RESOLUTION));
  });

  it('steps from the window in the URL, not the snapped one', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const requested = { fromMs: 20_000, toMs: 40_000, bucketWidthMs: 0 };
    await renderBrush({
      onChange,
      window: requested,
      applied: { fromMs: 20_000, toMs: 41_000, bucketWidthMs: 1_000 },
    });
    await user.click(screen.getByTestId('window-step-forward'));
    expect(onChange).toHaveBeenLastCalledWith(stepWindow(requested, 'forward', WHOLE.toMs, RESOLUTION));
  });

  it('stops Forward at the run’s end', async () => {
    await renderBrush({ window: { fromMs: 40_000, toMs: 63_161 } });
    expect(screen.getByTestId('window-step-forward')).toBeDisabled();
    expect(screen.getByTestId('window-step-backward')).toBeEnabled();
  });

  it('offers no step until the navigator’s resolution is known', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 500 })));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TimeBrush runId={RUN} runDurationMs={63_161} window={null} onChange={() => undefined} />
      </QueryClientProvider>,
    );
    // Asserted AFTER the series request has answered, with an error: still no
    // resolution, so still no step — not merely a first paint before the fetch.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    for (const { step } of WINDOW_STEPS) {
      expect(screen.getByTestId(`window-step-${step}`)).toBeDisabled();
    }
  });
});
