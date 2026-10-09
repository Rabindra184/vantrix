// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRole } from '@perfportal/contracts';
import { RoleChange, nameWithEmailIfShared } from '../src/routes/AdminFields';

// No vitest globals here, so Testing Library's automatic cleanup never
// registers; without this every render stacks in one `document.body`.
afterEach(cleanup);

/**
 * `RoleChange`: a role picked, then saved. The select only stages a choice —
 * a native select fires `change` on every ArrowDown, so a control that sent
 * each one would send a request per option a keyboard reader arrows past —
 * and `Save` sends it. Driven through the DOM: the claims are about what the
 * reader can press and what reaches `onSave`.
 */
function mount(current: ProjectRole, pending = false, labelHidden?: boolean) {
  const onSave = vi.fn<(role: ProjectRole) => void>();
  const element = (role: ProjectRole, busy: boolean) => (
    <>
      <RoleChange
        id="role-checkout"
        qualifier="in Checkout"
        current={role}
        pending={busy}
        onSave={onSave}
        labelHidden={labelHidden}
      />
      {/* Somewhere else on the page for a reader to take the caret. */}
      <button type="button">Elsewhere</button>
    </>
  );
  const view = render(element(current, pending));
  const rerender = (next: ProjectRole, nextPending = false) => view.rerender(element(next, nextPending));
  return { onSave, rerender };
}

const select = () => screen.getByRole('combobox', { name: 'Role in Checkout' });
const save = () => screen.queryByRole('button', { name: 'Save role in Checkout' });

/** A keyboard reader arrowing a closed native select one option down: the
 *  browser moves the value and fires `change` (user-event does not model it). */
function arrowDown(element: HTMLElement) {
  const control = element as HTMLSelectElement;
  const next = control.options[Math.min(control.selectedIndex + 1, control.options.length - 1)]!;
  fireEvent.change(control, { target: { value: next.value } });
}

describe('RoleChange', () => {
  it('names its select after the line it is on, starting on the current role, with no Save', () => {
    mount('member');

    expect(select()).toHaveValue('member');
    expect([...(select() as HTMLSelectElement).options].map((option) => option.textContent)).toEqual([
      'Viewer',
      'Member',
      'Manager',
    ]);
    // Nothing to save while the choice is the role already held: no button of
    // its own at all (the one other button is the harness's "Elsewhere").
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Elsewhere']);
  });

  it('stages a choice without sending it, and offers a Save named after its line', async () => {
    const { onSave } = mount('member');
    const clicker = userEvent.setup();

    await clicker.selectOptions(select(), 'Manager');

    expect(onSave).not.toHaveBeenCalled();
    expect(select()).toHaveValue('manager');
    const button = save();
    expect(button).toBeInTheDocument();
    // Not `primary`: a page has one, and a per-line Save is never it.
    expect(button!.className).not.toContain('bg-accent');
  });

  it('sends the staged role once, on Save', async () => {
    const { onSave } = mount('member');
    const clicker = userEvent.setup();

    await clicker.selectOptions(select(), 'Viewer');
    await clicker.click(save()!);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('viewer');
  });

  it('withdraws Save once the choice is moved back to the current role', async () => {
    mount('member');
    const clicker = userEvent.setup();

    await clicker.selectOptions(select(), 'Manager');
    expect(save()).toBeInTheDocument();
    await clicker.selectOptions(select(), 'Member');

    expect(save()).toBeNull();
  });

  it('sends ONE request for a keyboard reader who arrows through every role before saving', async () => {
    const { onSave } = mount('viewer');
    const clicker = userEvent.setup();

    // Viewer, Member, Manager — and an ArrowDown past the last, which stays put.
    arrowDown(select());
    arrowDown(select());
    arrowDown(select());
    expect(select()).toHaveValue('manager');
    expect(onSave).not.toHaveBeenCalled();

    await clicker.click(save()!);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('manager');
  });

  it('locks the select and its Save while a request is in flight', async () => {
    const { onSave, rerender } = mount('member');
    const clicker = userEvent.setup();

    await clicker.selectOptions(select(), 'Manager');
    rerender('member', true);

    expect(save()).toBeDisabled();
    expect(select()).toBeDisabled();
    // The choice being sent stays on screen while it is sent.
    expect(select()).toHaveValue('manager');
    await clicker.click(save()!);
    expect(onSave).not.toHaveBeenCalled();
  });

  /* The save's own answer: the role it set comes back as `current`, and the
     staged choice — now the role held — has nothing left to save. And a role
     changed by someone else replaces whatever was staged over the old one. */
  it('starts again from the current role whenever the current role changes', async () => {
    const { rerender } = mount('member');
    const clicker = userEvent.setup();

    await clicker.selectOptions(select(), 'Manager');
    rerender('manager');
    expect(select()).toHaveValue('manager');
    expect(save()).toBeNull();

    await clicker.selectOptions(select(), 'Member');
    rerender('viewer');
    expect(select()).toHaveValue('viewer');
    expect(save()).toBeNull();
  });

  /* The converse: a re-render that leaves the current role alone — another
     line's change re-reading the list — keeps what the reader has staged. */
  it('keeps a staged choice through a re-render that leaves the current role alone', async () => {
    const { rerender } = mount('member');
    const clicker = userEvent.setup();

    await clicker.selectOptions(select(), 'Manager');
    rerender('member');

    expect(select()).toHaveValue('manager');
    expect(save()).toBeInTheDocument();
  });
});

/**
 * ═══ THE CARET AFTER A SAVE, IN ONE PLACE (ruling P12) ═══
 *
 * The Save a reader pressed goes once the role it sent comes back as
 * `current`, which would leave the caret on nothing. `RoleChange` puts it on
 * its own select then — for every owner, so neither the Administration panel
 * nor the Members table has to aim it.
 */
describe('RoleChange — the caret after a save', () => {
  /** Drops the caret to the page, as a browser may when the control holding it
   *  is disabled mid-request. jsdom never does that itself. */
  function dropCaret() {
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    act(() => {
      elsewhere.focus();
      elsewhere.blur();
    });
    expect(document.activeElement).toBe(document.body);
  }

  it('moves the caret to its select once the role it saved comes back, the Save having gone', async () => {
    const { rerender } = mount('member');
    const clicker = userEvent.setup();
    await clicker.selectOptions(select(), 'Manager');
    await clicker.click(save()!);
    expect(save()).toHaveFocus();

    rerender('member', true);
    rerender('manager', true);
    rerender('manager', false);

    expect(save()).toBeNull();
    expect(select()).toHaveFocus();
  });

  it('moves it there too when the caret was lost to the page while the save was in flight', async () => {
    const { rerender } = mount('member');
    const clicker = userEvent.setup();
    await clicker.selectOptions(select(), 'Manager');
    await clicker.click(save()!);
    rerender('member', true);
    dropCaret();

    rerender('manager', false);

    expect(select()).toHaveFocus();
  });

  /* The converse: a reader who has taken the caret somewhere else keeps it there. */
  it('leaves the caret where the reader took it while the save was in flight', async () => {
    const { rerender } = mount('member');
    const clicker = userEvent.setup();
    await clicker.selectOptions(select(), 'Manager');
    await clicker.click(save()!);
    rerender('member', true);
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    act(() => elsewhere.focus());

    rerender('manager', false);

    expect(elsewhere).toHaveFocus();
  });

  /* A refused save leaves the role as it was: the Save stays, and so does the
     caret — where it goes then is the owner's to decide. */
  it('leaves the caret alone when the save is answered without the role moving', async () => {
    const { rerender } = mount('member');
    const clicker = userEvent.setup();
    await clicker.selectOptions(select(), 'Manager');
    await clicker.click(save()!);
    rerender('member', true);

    rerender('member', false);

    expect(save()).toHaveFocus();
  });

  /* A role changed by somebody else, with no save of this line's in flight,
     takes away a Save the reader had only staged — and not the caret. */
  it('does not take the caret for a role somebody else changed', async () => {
    const { rerender } = mount('member');
    const clicker = userEvent.setup();
    await clicker.selectOptions(select(), 'Manager');
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    act(() => elsewhere.focus());

    rerender('viewer');

    expect(save()).toBeNull();
    expect(elsewhere).toHaveFocus();
  });
});

/**
 * A table cell under a `Role` column header needs no visible "Role" over each
 * select, and must still name it after its line for a screen reader.
 */
describe('RoleChange — labelHidden', () => {
  it('hides the whole label, keeping both controls’ names', async () => {
    mount('member', false, true);
    const label = (select() as HTMLSelectElement).labels?.[0];
    expect(label).toBeDefined();
    expect(label!.className.split(' ')).toContain('sr-only');

    await userEvent.setup().selectOptions(select(), 'Manager');
    expect(save()).toBeInTheDocument();
  });

  it('draws the label by default, as the Administration panel has it', () => {
    mount('member');
    const label = (select() as HTMLSelectElement).labels?.[0];
    expect(label).toBeDefined();
    expect(label!.className.split(' ')).not.toContain('sr-only');
  });
});

/**
 * PR 2's ruling W6, as one function both tables call: a display name another
 * person shares — case and spacing aside, as a screen reader reads them —
 * brings its email along; every other name is the plain one.
 */
describe('nameWithEmailIfShared', () => {
  const sam = { name: 'Sam Lee', email: 'sam.one@example.test' };
  const twin = { name: 'sam  lee', email: 'sam.two@example.test' };
  const bo = { name: 'Bo Member', email: 'bo@example.test' };

  it('adds the email to a name somebody else shares, however it is cased or spaced', () => {
    expect(nameWithEmailIfShared(sam, [sam, twin, bo])).toBe('Sam Lee (sam.one@example.test)');
    expect(nameWithEmailIfShared(twin, [sam, twin, bo])).toBe('sam  lee (sam.two@example.test)');
  });

  it('keeps a name nobody else has as it is', () => {
    expect(nameWithEmailIfShared(bo, [sam, twin, bo])).toBe('Bo Member');
    expect(nameWithEmailIfShared(sam, [sam, bo])).toBe('Sam Lee');
  });
});
