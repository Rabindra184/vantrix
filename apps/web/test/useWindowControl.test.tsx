import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTLE_MS, useWindowControl } from '../src/charts/useWindowControl';

/**
 * The time-window control's behaviour, shared by `TimeBrush` and Compare's
 * overlay. `TimeBrush.test.tsx` covers the fields through the run page's
 * markup; these pin the two rules about a drag that is still settling, which
 * the copy this hook replaced got wrong.
 */

const EXTENT = 63_161;
const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 50)));

afterEach(cleanup);

describe('useWindowControl — a drag still settling', () => {
  it('lets Apply leave the drag to land, as the reader made it', async () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useWindowControl({ window: null, extentMs: EXTENT, onChange }));

    act(() => result.current.drag(10_000, 20_000));
    // The fields still describe the window from before the drag: empty, the
    // whole run. Apply commits that — and must not cancel the drag.
    act(() => result.current.apply());
    await settled();

    expect(onChange).toHaveBeenLastCalledWith({ fromMs: 10_000, toMs: 20_000, bucketWidthMs: 0 });
  });

  it('lets a navigation cancel the drag, so it cannot land after and undo it', async () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useWindowControl({ window: null, extentMs: EXTENT, onChange }));

    act(() => result.current.drag(10_000, 20_000));
    act(() => result.current.navigate(null));
    await settled();

    expect(onChange.mock.calls).toEqual([[null]]);
  });
});
