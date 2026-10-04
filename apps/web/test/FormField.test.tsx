import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import FormField, { errorId, hintId, noticeId } from '../src/components/FormField';

afterEach(cleanup);

/**
 * ═══ A FIELD IS A LABEL; ITS HINT IS ONE CLICK AWAY (clean UI, PR 4) ═══
 *
 * Forms printed a help line under fields whose label already said what they
 * were. The hint moves behind an ⓘ beside the label — never inside it, where
 * the trigger would join the control's accessible name — and stays the
 * control's description, so a screen reader still hears it on focus. The only
 * lines left under a control are a degraded state the reader must act on
 * (`notice`) and a validation error (`error`).
 */
describe('FormField', () => {
  it('names the control by its label, with the optional marker inside it', () => {
    render(
      <FormField label="Branch" id="f-branch" optional>
        <input id="f-branch" />
      </FormField>,
    );
    expect(screen.getByRole('textbox')).toHaveAccessibleName('Branch (optional)');
  });

  it('puts the hint behind an info beside the label, and hands it to the control as one description', () => {
    render(
      <FormField label="Test" id="f-test" hint="Which test this run belongs to.">
        <input id="f-test" aria-describedby={hintId('f-test')} />
      </FormField>,
    );
    const input = screen.getByRole('textbox');
    expect(input).toHaveAccessibleName('Test');
    expect(input).toHaveAccessibleDescription('Which test this run belongs to.');
    const tip = screen.getByRole('button', { name: 'About Test' });
    expect(tip.closest('label')).toBeNull();
    expect(tip).toHaveAccessibleDescription('Which test this run belongs to.');
    expect(document.querySelectorAll(`[id="${hintId('f-test')}"]`)).toHaveLength(1);
    expect(document.getElementById(hintId('f-test'))).not.toBeVisible();
  });

  it('draws no info without a hint', () => {
    render(
      <FormField label="Name" id="f-name">
        <input id="f-name" />
      </FormField>,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a notice and an error as visible lines at their own ids', () => {
    render(
      <FormField
        label="Test"
        id="f-t"
        notice="Tests couldn't be loaded — type the slug."
        error="Line 2 must be key=value."
      >
        <input id="f-t" aria-describedby={`${noticeId('f-t')} ${errorId('f-t')}`} />
      </FormField>,
    );
    expect(document.getElementById(noticeId('f-t'))).toBeVisible();
    expect(document.getElementById(errorId('f-t'))).toBeVisible();
    expect(screen.getByRole('textbox')).toHaveAccessibleDescription(
      "Tests couldn't be loaded — type the slug. Line 2 must be key=value.",
    );
  });

  /**
   * FINAL REVIEW, IMPORTANT 1: a status colour as TEXT fails AA on the sunken
   * ground in the light theme (failed 4.27:1, pending 4.44:1 — CLAUDE.md
   * records `palette.test.ts` gating the tones against the card only), and a
   * field can sit on either ground. The words are the primary colour; the
   * status colour is a left rule, which needs only 3:1 as a non-text mark.
   */
  it('keeps a notice and an error readable on any ground', () => {
    render(
      <FormField label="X" id="f-x" notice="Degraded." error="Wrong.">
        <input id="f-x" />
      </FormField>,
    );
    for (const [id, tone] of [
      [noticeId('f-x'), '--color-status-pending'],
      [errorId('f-x'), '--color-status-failed'],
    ] as const) {
      const line = document.getElementById(id) as HTMLElement;
      expect(line).toHaveClass('text-primary');
      expect(line.style.color).toBe('');
      expect(line.style.borderLeftColor).toBe(`var(${tone})`);
    }
  });
});
