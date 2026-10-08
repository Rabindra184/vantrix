// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRole } from '@perfportal/contracts';
import { RoleChange } from '../src/routes/AdminFields';

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
function mount(current: ProjectRole, pending = false) {
  const onSave = vi.fn<(role: ProjectRole) => void>();
  const view = render(
    <RoleChange id="role-checkout" qualifier="in Checkout" current={current} pending={pending} onSave={onSave} />,
  );
  const rerender = (next: ProjectRole, nextPending = false) =>
    view.rerender(
      <RoleChange id="role-checkout" qualifier="in Checkout" current={next} pending={nextPending} onSave={onSave} />,
    );
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
    // Nothing to save while the choice is the role already held.
    expect(screen.queryByRole('button')).toBeNull();
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
