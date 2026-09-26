import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ElapsedOnly, TimeAxisProvider, useTimeAxis } from '../src/charts/TimeAxisContext';
import { TIME_AXIS_STORAGE_KEY } from '../src/timeAxisPreference';

// `vitest.config.ts` sets no `globals`, so Testing Library's automatic cleanup
// never registers; see `RequestDetail.test.tsx` for what leaking DOM costs.
afterEach(() => {
  cleanup();
  localStorage.removeItem(TIME_AXIS_STORAGE_KEY);
});

const ANCHOR = '2026-08-15T11:42:09.000Z';

/** The last value the probe read, for calling `setMode` from a test. */
const seen: { value?: ReturnType<typeof useTimeAxis> } = {};

function Probe() {
  seen.value = useTimeAxis();
  return <span data-testid="probe">{`${seen.value.mode}|${String(seen.value.anchorMs)}`}</span>;
}

describe('TimeAxisProvider', () => {
  it('opens on Offset when nothing is stored', () => {
    render(
      <TimeAxisProvider anchor={ANCHOR}>
        <Probe />
      </TimeAxisProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent(`offset|${Date.parse(ANCHOR)}`);
  });

  it('opens on the stored mode', () => {
    localStorage.setItem(TIME_AXIS_STORAGE_KEY, 'datetime');
    render(
      <TimeAxisProvider anchor={ANCHOR}>
        <Probe />
      </TimeAxisProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent(/^datetime\|/);
  });

  it('remembers a change, so the next page opens on it', () => {
    const first = render(
      <TimeAxisProvider anchor={ANCHOR}>
        <Probe />
      </TimeAxisProvider>,
    );
    act(() => seen.value!.setMode('datetime'));
    expect(screen.getByTestId('probe')).toHaveTextContent(/^datetime\|/);

    first.unmount();
    render(
      <TimeAxisProvider anchor={ANCHOR}>
        <Probe />
      </TimeAxisProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent(/^datetime\|/);
  });

  it('has no anchor for a run that recorded none, or an unreadable one', () => {
    render(
      <TimeAxisProvider anchor={null}>
        <Probe />
      </TimeAxisProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('offset|null');
    cleanup();

    render(
      <TimeAxisProvider anchor="not-a-date">
        <Probe />
      </TimeAxisProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('offset|null');
  });
});

describe('ElapsedOnly', () => {
  it('pins elapsed time beneath it, whatever the viewer chose', () => {
    localStorage.setItem(TIME_AXIS_STORAGE_KEY, 'datetime');
    render(
      <TimeAxisProvider anchor={ANCHOR}>
        <ElapsedOnly>
          <Probe />
        </ElapsedOnly>
      </TimeAxisProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('offset|null');
  });
});

describe('outside any provider', () => {
  it('reads elapsed time, so a chart on its own renders as it always has', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('offset|null');
  });
});
