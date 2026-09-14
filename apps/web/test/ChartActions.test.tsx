import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChartActions from '../src/charts/ChartActions.js';

const downloadCsv = vi.fn();
vi.mock('../src/tables/csv.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/tables/csv.js')>()),
  // `toCsv` stays REAL. The point of the download cases is what the file
  // contains, and a stubbed serializer would let this file agree with itself
  // about a format neither of them produces.
  downloadCsv: (filename: string, csv: string) => downloadCsv(filename, csv),
}));

const ROWS = [
  { label: '0', values: [12, 1] },
  { label: '1000', values: [24.916201117318437, null as unknown as number] },
];

/**
 * Opens the chart's overflow menu.
 *
 * Review M17 moved the table toggle and both exports behind one trigger: every
 * chart carried four controls and the Charts tab draws ten of them, so a
 * reader looking at one figure met forty. Full screen stayed a button because
 * it acts on the thing being looked at; these three did not.
 *
 * So a case that means to press one of them opens the menu first, exactly as a
 * reader does. The menu is PORTALLED and mounted only while open — which is
 * what keeps the "ten charts, one status region" reasoning in `ChartActions`
 * honest, and what makes this helper necessary rather than cosmetic.
 */
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /data and exports$/ }));
  await screen.findByRole('menu');
}

function renderActions(over: Partial<Parameters<typeof ChartActions>[0]> = {}) {
  const props = {
    id: 'requests-per-second',
    title: 'Requests per second',
    columns: ['Elapsed (s)', 'All', 'KO'],
    rows: ROWS,
    tableShown: false,
    onToggleTable: vi.fn(),
    expanded: false,
    onToggleExpanded: vi.fn(),
    expandable: true,
    ...over,
  };
  return { props, ...render(<ChartActions {...props} />) };
}

/**
 * `userEvent.setup()` INSTALLS ITS OWN CLIPBOARD, as a getter-only property,
 * which is why `Object.assign(navigator, …)` — the spelling `ProjectSetup.test`
 * uses — throws here and not there: that file drives with `fireEvent` and
 * never calls setup. So this redefines the property instead, and every caller
 * does it AFTER `userEvent.setup()` has had its turn.
 */
function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true });
}

const writeText = () => vi.mocked((navigator as Navigator).clipboard.writeText);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('ChartActions — the table toggle', () => {
  /**
   * ═══ THE CONTRACT WITH `DataTable`, FROM THIS END ═══
   *
   * `aria-controls` is how assistive tech — and every e2e spec that opens a
   * table — finds the button belonging to ONE of the ten charts on a page.
   * Picking the nth "show data table" button by index would assert nothing
   * about which table it opens, which is why the specs never did.
   */
  it('points at the table it opens, by the id that table actually has', async () => {
    renderActions();
    const user = userEvent.setup();

    /* AND THE TRIGGER IS NAMED AFTER ITS OWN CHART, which is the same claim
       one element up. Ten overflow buttons all called "Chart actions" in one
       document is the duplicate-accessible-name defect CLAUDE.md records three
       separate times — and `openMenu`'s own `/data and exports$/` cannot see
       it, because a static name matches that just as happily. Only an
       assertion naming the TITLE can, and Testing Library matches a name
       EXACTLY, so this pins the whole string. */
    expect(
      screen.getByRole('button', { name: 'Requests per second: data and exports' }),
    ).toBeInTheDocument();

    await openMenu(user);
    expect(screen.getByRole('menuitem', { name: 'Show the data table' })).toHaveAttribute(
      'aria-controls',
      'chart-data-requests-per-second',
    );
  });

  /**
   * `aria-expanded`, NOT `aria-pressed`, and the reason is not style. The plot
   * is `aria-hidden`, so to assistive technology nothing is being replaced —
   * a region is appearing. `aria-pressed` would describe a change of visual
   * arrangement no screen reader can observe.
   */
  it('reports the disclosure state, in both directions', async () => {
    const user = userEvent.setup();
    const { props } = renderActions();

    await openMenu(user);
    const button = screen.getByRole('menuitem', { name: 'Show the data table' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(props.onToggleTable).toHaveBeenCalledTimes(1);

    cleanup();
    renderActions({ tableShown: true });
    // A fresh render is a fresh CLOSED menu: Radix mounts the content only
    // while open, so the second half of this case has to open it again.
    await openMenu(user);
    expect(screen.getByRole('menuitem', { name: 'Show the chart' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  /**
   * The name says what the NEXT activation does, because there is no visible
   * label to contradict it — the same rule `ProjectRail`'s collapse toggle
   * follows. A button that still said "Show the data table" while the table
   * was open would be the only thing telling a non-sighted reader what state
   * they are in, and it would be lying.
   */
  it('names the action it will perform, not the state it is in', async () => {
    renderActions({ tableShown: true });
    expect(screen.queryByRole('button', { name: 'Show the data table' })).toBeNull();
    const user = userEvent.setup();
    await openMenu(user);
    expect(screen.getByRole('menuitem', { name: 'Show the chart' })).toBeInTheDocument();
  });
});

describe('ChartActions — taking the numbers away', () => {
  it('writes a CSV whose header and rows are the table on screen', async () => {
    const user = userEvent.setup();
    renderActions();
    await openMenu(user);

    await user.click(screen.getByRole('menuitem', { name: 'Download the chart data as CSV' }));

    expect(downloadCsv).toHaveBeenCalledTimes(1);
    const [filename, csv] = downloadCsv.mock.calls[0]!;
    expect(filename).toBe('perfportal-requests-per-second.csv');
    const lines = (csv as string).split('\r\n');
    expect(lines[0]).toBe('"Elapsed (s)","All","KO"');
    expect(lines[1]).toBe('"0","12","1"');
  });

  /**
   * ROUNDED IN THE FILE, exactly as on screen — the convention `statisticsCsv`
   * already set. The CSV is "this table, as a file"; the clipboard JSON below
   * is the route that keeps every digit.
   */
  it('rounds a cell in the CSV the same way the cell itself rounds', async () => {
    renderActions();
    const user = userEvent.setup();
    await openMenu(user);
    screen.getByRole('menuitem', { name: 'Download the chart data as CSV' }).click();
    expect(downloadCsv.mock.calls[0]![1]).toContain('"24.92"');
    expect(downloadCsv.mock.calls[0]![1]).not.toContain('24.916201117318437');
  });

  /**
   * EMPTY, NOT ZERO, for a gap. A spreadsheet folds a zero into an average and
   * leaves a blank out, so writing `0` for a bucket nothing was measured in
   * silently drags every aggregate the reader computes downward.
   */
  it('writes an empty cell for a gap, never a zero', async () => {
    renderActions();
    const user = userEvent.setup();
    await openMenu(user);
    screen.getByRole('menuitem', { name: 'Download the chart data as CSV' }).click();
    const lines = (downloadCsv.mock.calls[0]![1] as string).split('\r\n');
    expect(lines[2]).toBe('"1000","24.92",""');
  });

  it('copies the unrounded values as JSON', async () => {
    const user = userEvent.setup();
    setClipboard({ writeText: vi.fn(async () => undefined) });
    renderActions();
    await openMenu(user);

    await user.click(screen.getByRole('menuitem', { name: 'Copy the chart data as JSON' }));

    const payload = JSON.parse(writeText().mock.calls[0]![0] as string);
    expect(payload.chart).toBe('requests-per-second');
    // The exact value, not the two decimals the CSV and the cell carry.
    expect(payload.rows[1].values[0]).toBe(24.916201117318437);
  });

  /**
   * ═══ THE CLIPBOARD IS ABSENT ON A NON-SECURE PAGE ═══
   *
   * Plain http on anything but localhost, i.e. an ordinary way to reach an
   * on-prem install. The token screen shipped this bug once already: it
   * optional-chained the clipboard, so `await undefined` resolved and the
   * button reported success over a copy that went nowhere. A copy button that
   * lies is worse than one that is missing — the reader is about to paste.
   */
  it('names the SECURE-CONTEXT cause only when the clipboard is genuinely absent', async () => {
    const user = userEvent.setup();
    setClipboard(undefined);
    renderActions();

    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Copy the chart data as JSON' }));

    // Visible, not merely announced — the reader is about to paste.
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/not a secure context/i);
    expect(status).not.toHaveClass('sr-only');
  });

  /**
   * ═══ A REJECTED WRITE IS NOT AN INSECURE PAGE ═══
   *
   * Both used to produce the same sentence, and it was WRONG for this half:
   * observed on a secure localhost page where `navigator.clipboard` was
   * present and `writeText` rejected with NotAllowedError, while the message
   * on screen told the reader their page was insecure. Denied permission, an
   * unfocused document and a missing user gesture all land here and none of
   * them is a secure-context problem.
   *
   * So this asserts the message says what is KNOWN and NOT the cause it cannot
   * establish — the same discipline the token revoke follows with "may still
   * be active".
   */
  it('does not blame the secure context when the clipboard merely refused', async () => {
    const user = userEvent.setup();
    setClipboard({ writeText: vi.fn(async () => { throw new Error('denied'); }) });
    renderActions();

    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Copy the chart data as JSON' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/blocked by the browser/i);
    expect(status).not.toHaveTextContent(/secure context/i);
  });

  /**
   * TEN CHARTS, TEN LIVE REGIONS, if this were always mounted — and a
   * page-wide `getByRole('status')` would then resolve eleven elements and
   * silently answer a different question. It broke `RunTelemetry`'s
   * clock-skew test within a minute of being written that way.
   */
  it('contributes no status role at all until it has something to announce', () => {
    renderActions();
    expect(screen.queryByRole('status')).toBeNull();
  });

  /**
   * Disabled rather than hidden. A header whose control COUNT changes per
   * chart makes the reader re-find each one on every card, and on a page of
   * ten charts two of which are empty that is a real cost. `title` carries
   * the reason, so the control is not merely inert and unexplained.
   */
  it('cannot export a chart that plotted nothing, and says why', async () => {
    renderActions({ rows: [] });
    const user = userEvent.setup();
    await openMenu(user);
    /* `aria-disabled`, not `disabled`: a Radix menu item is a `div` with
       `role="menuitem"`, so `toBeDisabled()` asks for an attribute it can
       never have. The PROMISE is the same — the control refuses — and this is
       the spelling that carries it to assistive technology. */
    const csv = screen.getByRole('menuitem', { name: 'Download the chart data as CSV' });
    expect(csv).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: 'Copy the chart data as JSON' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    /* AND IT SAYS WHY, IN TEXT. As buttons these carried the reason in a
       `title` — invisible on touch, unreachable by keyboard, and now hidden
       behind a menu as well. A refusal nobody can read is not a refusal
       anybody can act on. */
    expect(screen.getByText(/nothing to export/i)).toBeInTheDocument();
  });
});

describe('ChartActions — full screen', () => {
  it('offers to expand, and names the way back once expanded', async () => {
    const user = userEvent.setup();
    const { props } = renderActions();

    await user.click(screen.getByRole('button', { name: 'Show the chart full screen' }));
    expect(props.onToggleExpanded).toHaveBeenCalledTimes(1);

    cleanup();
    renderActions({ expanded: true });
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeInTheDocument();
  });

  /**
   * Filling the screen with an explanation of why there is no chart is not a
   * bigger view of anything.
   */
  it('will not expand a chart with nothing to draw', () => {
    renderActions({ expandable: false });
    expect(screen.getByRole('button', { name: 'Show the chart full screen' })).toBeDisabled();
  });
});

/**
 * ═══ THE PROMISE A ROLE MAKES ═══
 *
 * M17 moved three controls behind `role="menu"`, and that choice was argued
 * here on exactly one ground: `AccountMenu` is a real menu, and `ThemeToggle`
 * earned this repo the lesson that half-keeping a role is worse than not
 * claiming it — a screen reader announces "menu", its user presses an arrow
 * key because that is what the word means, and nothing happens.
 *
 * `AccountMenu.test.tsx` checks that promise for the OLDER menu. Nothing
 * checked it for this one, which is the menu that was added to satisfy the
 * finding. Radix honours it today; the point of a test is that Radix is a
 * dependency and a hand-rolled `<div role="menu">` is one refactor away.
 *
 * ASSERTED ON FOCUS MOVING, NOT ON A KEY BEING HANDLED — the same shape
 * `ThemeToggle`'s roving-tabindex cases had to take, because a menu that
 * swallows the key and leaves the caret where it was is precisely the defect.
 */
describe('ChartActions — the promise a role makes', () => {
  it('moves between items with the arrow keys', async () => {
    const user = userEvent.setup();
    renderActions();
    await openMenu(user);
    await screen.findAllByRole('menuitem');

    await user.keyboard('{ArrowDown}');
    const first = document.activeElement;
    expect(first).not.toBeNull();
    expect(first).toHaveAttribute('role', 'menuitem');

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).not.toBe(first);
    expect(document.activeElement).toHaveAttribute('role', 'menuitem');
  });

  /**
   * FOCUS RETURN IS THE HALF THAT STRANDS SOMEBODY. A menu that closes without
   * putting the caret back drops a keyboard user at the top of the document,
   * and on the Charts tab that is nine figures above where they were reading.
   */
  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderActions();
    const trigger = screen.getByRole('button', { name: /data and exports$/ });
    await openMenu(user);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
