import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ThemeToggle from '../src/components/ThemeToggle';

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

const radios = () => screen.getAllByRole('radio');
const checked = () => radios().find((r) => r.getAttribute('aria-checked') === 'true');

/**
 * ═══ WHAT `role="radio"` PROMISES ═══
 *
 * The control shipped with the ARIA roles and none of the keyboard behaviour
 * they announce, on the argument that three tab stops were cheaper than an
 * interaction with no test over it. This file is that test, so the argument
 * no longer applies in either direction.
 *
 * The point of each case below is a promise the ROLE makes: one tab stop, and
 * arrows that move the selection. A screen reader says "1 of 3" whether or
 * not any of it works.
 */
describe('ThemeToggle keyboard behaviour', () => {
  it('exposes exactly one tab stop, and it is the checked segment', () => {
    render(<ThemeToggle />);
    const stops = radios().filter((r) => r.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(checked());
    // The whole rest of the group is reachable by arrow key only — which is
    // what makes this ONE stop rather than three.
    expect(radios().filter((r) => r.getAttribute('tabindex') === '-1')).toHaveLength(2);
  });

  it('moves the tab stop with the selection', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole('radio', { name: 'Light theme' }));
    expect(screen.getByRole('radio', { name: 'Light theme' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Dark theme' })).toHaveAttribute('tabindex', '-1');
  });

  it('selects the next option on ArrowRight, and moves focus with it', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    const light = screen.getByRole('radio', { name: 'Light theme' });
    await user.click(light);
    await user.keyboard('{ArrowRight}');

    const dark = screen.getByRole('radio', { name: 'Dark theme' });
    expect(dark).toHaveAttribute('aria-checked', 'true');
    // FOCUS, not just state: a roving tabindex that never moves focus leaves
    // the caret on a segment that is no longer the tab stop, so the next Tab
    // leaves the group from the wrong place.
    expect(dark).toHaveFocus();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('treats ArrowDown as ArrowRight and ArrowUp as ArrowLeft', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole('radio', { name: 'Light theme' }));
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Dark theme' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('radio', { name: 'Light theme' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('wraps in both directions', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole('radio', { name: 'Light theme' }));
    // Left from the first option lands on the last.
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'System theme' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // And right from the last comes back round to the first.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Light theme' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('jumps to the ends with Home and End', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole('radio', { name: 'Dark theme' }));
    await user.keyboard('{Home}');
    expect(screen.getByRole('radio', { name: 'Light theme' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.keyboard('{End}');
    expect(screen.getByRole('radio', { name: 'System theme' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('leaves exactly one option checked, whatever the route in', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole('radio', { name: 'Dark theme' }));
    await user.keyboard('{ArrowRight}{ArrowRight}{Home}{End}');
    expect(radios().filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
  });

  it('persists the arrow-key choice the same way a click does', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole('radio', { name: 'Light theme' }));
    await user.keyboard('{ArrowRight}');
    // The storage key is the one `index.html`'s pre-paint script reads by
    // hand; a keyboard choice that did not persist would be forgotten on reload.
    expect(localStorage.getItem('perfportal-theme')).toBe('dark');
  });

  it('ignores a key it does not handle', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole('radio', { name: 'Light theme' }));
    await user.keyboard('{PageDown}');
    expect(screen.getByRole('radio', { name: 'Light theme' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});
