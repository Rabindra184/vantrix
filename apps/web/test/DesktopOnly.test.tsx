import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DesktopOnly from '../src/routes/DesktopOnly';

afterEach(cleanup);

/**
 * §22.6: below 768px "deep analysis is explicitly a desktop task, and the
 * mobile view SAYS SO rather than degrading badly".
 *
 * ═══ THE POINT IS WHAT IS NOT BUILT ═══
 *
 * `children` is a function precisely so the withheld content is never
 * constructed. A node would be built by the caller before this component could
 * decide anything, so the charts would mount, their queries subscribe and their
 * ECharts instances initialise — and be thrown away. The first test is
 * therefore about a spy that must NOT have been called, which is the only way
 * to assert an absence of work.
 */
describe('DesktopOnly', () => {
  it('renders the content untouched on a wide viewport', () => {
    const build = vi.fn(() => <p>the charts</p>);
    render(<DesktopOnly compact={false} what="Reading eight charts">{build}</DesktopOnly>);

    expect(screen.getByText('the charts')).toBeInTheDocument();
    expect(screen.queryByTestId('desktop-only')).not.toBeInTheDocument();
  });

  it('does not BUILD the content when compact — not merely hide it', () => {
    const build = vi.fn(() => <p>the charts</p>);
    render(<DesktopOnly compact what="Reading eight charts">{build}</DesktopOnly>);

    expect(build).not.toHaveBeenCalled();
    expect(screen.queryByText('the charts')).not.toBeInTheDocument();
  });

  it('says which thing is being withheld, rather than a generic apology', () => {
    render(<DesktopOnly compact what="A comparison of these runs">{() => null}</DesktopOnly>);
    expect(
      screen.getByRole('heading', { name: 'A comparison of these runs' }),
    ).toBeInTheDocument();
  });

  /**
   * ═══ THE WORDING JUDGED THE READER, AND REVIEW M18 SAID SO ═══
   *
   * The heading read "{what} is a desktop task" over a button saying "Show it
   * anyway": the first tells somebody holding a phone that what they want is
   * not for them, and the second frames taking it as going against advice.
   *
   * Both halves are asserted as ABSENCES as well as presences, because the
   * replacement is a wording change and a wording change is exactly what drifts
   * back. `action` names the destination; the fallback is generic on purpose,
   * so a caller that forgets one degrades to "Open it" rather than to a
   * sentence about desktops.
   */
  it('names the destination on its button and does not judge the device', () => {
    render(
      <DesktopOnly compact what="The per-request statistics table" action="Open detailed table">
        {() => null}
      </DesktopOnly>,
    );

    const notice = screen.getByTestId('desktop-only');
    expect(screen.getByRole('button', { name: 'Open detailed table' })).toBeInTheDocument();
    expect(notice.textContent ?? '').not.toMatch(/desktop task|anyway|on a phone/i);
  });

  it('falls back to a generic action rather than to the old wording', () => {
    render(<DesktopOnly compact what="Eight charts of this run">{() => null}</DesktopOnly>);
    expect(screen.getByRole('button', { name: 'Open it' })).toBeInTheDocument();
  });

  it('is never a dead end — the override reveals the content', async () => {
    const build = vi.fn(() => <p>the charts</p>);
    render(<DesktopOnly compact what="Reading eight charts">{build}</DesktopOnly>);

    await userEvent.click(screen.getByTestId('desktop-only-show'));

    expect(screen.getByText('the charts')).toBeInTheDocument();
    expect(build).toHaveBeenCalled();
  });

  /**
   * CONTROLLED MODE exists because the withheld content usually needs DATA, and
   * the queries behind it are `enabled` on the caller's own flag. Keeping the
   * decision here would leave the caller fetching four payloads it had already
   * been told not to draw.
   */
  it('reports the click instead of revealing, when the caller owns the decision', async () => {
    const onShow = vi.fn();
    const build = vi.fn(() => <p>the charts</p>);
    render(
      <DesktopOnly compact what="Reading eight charts" onShow={onShow}>
        {build}
      </DesktopOnly>,
    );

    await userEvent.click(screen.getByTestId('desktop-only-show'));

    expect(onShow).toHaveBeenCalledTimes(1);
    // Still withheld: the caller re-renders with `compact={false}` (or stops
    // rendering this at all) once its own state has moved.
    expect(build).not.toHaveBeenCalled();
  });

  it('announces itself without interrupting — status, not alert', () => {
    // Nothing has gone wrong. An assertive live region would cut a screen
    // reader off mid-sentence to report a layout decision.
    render(<DesktopOnly compact what="Reading eight charts">{() => null}</DesktopOnly>);
    expect(screen.getByTestId('desktop-only')).toHaveAttribute('role', 'status');
  });
});
