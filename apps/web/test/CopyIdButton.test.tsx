import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CopyIdButton from '../src/components/CopyIdButton';

const RUN_ID = '3764bc74-1a2b-4c3d-8e4f-5a6b7c8d9f2e';

/**
 * jsdom ships NO `navigator.clipboard` — the same state a plain-http page is
 * in — so each case installs the one it means and the property is removed
 * afterwards. `defineProperty` rather than `Object.assign`, for the reason
 * `ChartActions.test.tsx` records: a getter-only property from a previous
 * install would make an assignment throw.
 */
function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true });
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.useRealTimers();
});

function renderButton() {
  return render(<CopyIdButton value={RUN_ID} label={`Copy run id ${RUN_ID}`} size="row" />);
}

describe('CopyIdButton', () => {
  /**
   * The WHOLE value, never a display form: the run list shows an 8-character
   * prefix on a test's page, and that prefix is not something any endpoint
   * takes. Named after its row, because a list of twenty-five buttons all
   * called "Copy" is the duplicate-name defect this repo has paid for three
   * times.
   */
  it('copies exactly the value it is given, and is named after it', async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard({ writeText });
    renderButton();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `Copy run id ${RUN_ID}` }));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(RUN_ID);
  });

  /**
   * A STATUS EXISTS ONLY WHILE THERE IS ONE TO GIVE. The run list renders this
   * twenty-five times a page, and twenty-five permanently-empty `role="status"`
   * elements turn every page-wide status query into a different question —
   * the trap `ChartActions` records breaking a test within a minute. So the
   * count before a click is part of the claim, not a precondition.
   */
  it('says nothing until it is used, then says it copied, then goes quiet again', async () => {
    vi.useFakeTimers();
    setClipboard({ writeText: vi.fn(async () => undefined) });
    renderButton();
    expect(screen.queryAllByRole('status')).toHaveLength(0);

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/copied/i);

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });

  /**
   * NEVER CLAIM A COPY THAT DID NOT HAPPEN. A plain-http page — an ordinary
   * way to reach an on-prem install, and exactly what
   * `PERFPORTAL_ALLOW_INSECURE_COOKIES` exists for — has no Clipboard API.
   * The token screen once said "Copied" over that state. Here the value
   * appears as text the reader can select, which always works.
   */
  it('shows the value to select by hand when the page has no clipboard', async () => {
    renderButton();

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    const status = screen.getByRole('status');
    expect(status).not.toHaveTextContent(/^copied/i);
    expect(status).toHaveTextContent(/not copied/i);
    expect(status).toHaveTextContent(RUN_ID);
  });

  /** A write the browser REFUSES is the same failure to the reader: the value
   *  did not reach the clipboard, and it is on screen instead. */
  it('does the same when the browser refuses the write', async () => {
    setClipboard({
      writeText: vi.fn(async () => {
        throw new Error('NotAllowedError');
      }),
    });
    renderButton();

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/not copied/i);
    expect(status).toHaveTextContent(RUN_ID);
  });
});
