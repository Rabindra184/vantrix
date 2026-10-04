import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import InfoTip from '../src/components/InfoTip';

/**
 * `InfoTip` is where a caveat goes once it is no longer printed on the page
 * (docs/superpowers/specs/2026-10-04-clean-ui-design.md, "The text rule").
 *
 * Two promises carry the whole design, and both are about a reader the page
 * no longer explains itself to. A screen-reader user must still get the caveat
 * — it is the trigger's DESCRIPTION, announced on focus without opening
 * anything. And the hidden copy that carries it must not become a second,
 * invisible tab stop, which is why a link inside it is tested while closed.
 */

afterEach(cleanup);

const tip = (label = 'About p95', body: ReactNode = 'p95 is an estimate, accurate to within 1%.') =>
  render(<InfoTip label={label}>{body}</InfoTip>);

describe('InfoTip', () => {
  it('names the trigger after its subject', () => {
    tip();
    expect(screen.getByRole('button', { name: 'About p95' })).toBeInTheDocument();
  });

  it('describes the trigger with the caveat while closed, and draws no panel', () => {
    tip();
    expect(screen.getByRole('button', { name: 'About p95' })).toHaveAccessibleDescription(
      'p95 is an estimate, accurate to within 1%.',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([['click'], ['{Enter}'], [' ']])('opens on %s', async (how) => {
    tip();
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'About p95' });
    if (how === 'click') {
      await user.click(trigger);
    } else {
      trigger.focus();
      await user.keyboard(how);
    }
    expect(await screen.findByRole('dialog', { name: 'About p95' })).toHaveTextContent('accurate to within 1%');
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    tip();
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'About p95' });
    await user.click(trigger);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  /**
   * THE KEYBOARD MUST NOT BE TRAPPED IN THE PANEL (final review, Important).
   * Radix moves focus into the content on open and its FocusScope loops Tab
   * there, so a reader who opened an ⓘ with Enter could not Tab on, could not
   * press Enter again to close it, and could not reach the next ⓘ — Escape was
   * the only way out. Focus stays on the trigger now.
   */
  it('keeps focus on the trigger after opening from the keyboard, so a second Enter closes it', async () => {
    tip();
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'About p95' });
    trigger.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: 'About p95' });
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lets Tab move on to the next control after opening from the keyboard', async () => {
    render(
      <>
        <InfoTip label="About p95">p95 is an estimate.</InfoTip>
        <button type="button">Next</button>
      </>,
    );
    const user = userEvent.setup();
    screen.getByRole('button', { name: 'About p95' }).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: 'About p95' });
    await user.tab();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus();
  });

  it('gives two InfoTips distinct names, and opening one closes the other', async () => {
    render(
      <>
        <InfoTip label="About p95">A.</InfoTip>
        <InfoTip label="About errors">B.</InfoTip>
      </>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'About p95' }));
    await screen.findByRole('dialog', { name: 'About p95' });
    await user.click(screen.getByRole('button', { name: 'About errors' }));
    expect(await screen.findByRole('dialog', { name: 'About errors' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'About p95' })).toBeNull();
  });

  it('keeps a link out of the tab order while closed and live in the panel', async () => {
    tip(
      'About vs previous',
      <>
        Compared with <a href="/runs/r10">Run 10</a>.
      </>,
    );
    expect(screen.queryByRole('link', { name: 'Run 10' })).toBeNull();
    const trigger = screen.getByRole('button', { name: 'About vs previous' });
    expect(trigger).toHaveAccessibleDescription('Compared with Run 10.');
    await userEvent.setup().click(trigger);
    expect(await screen.findByRole('link', { name: 'Run 10' })).toHaveAttribute('href', '/runs/r10');
  });
});
