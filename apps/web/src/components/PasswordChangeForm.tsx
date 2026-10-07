import { useEffect, useId, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ChangePasswordRequestSchema } from '@perfportal/contracts';
import Button from './Button';
import FormField, { errorId } from './FormField';
import { INPUT } from './tableStyles';
import { ProblemError } from '../api/fetch';
import { changeOwnPassword } from '../api/me';
import { fieldMessages } from '../formIssues';

type Field = 'currentPassword' | 'newPassword' | 'repeat';

/** Top to bottom, which is also the order the caret looks for a refused field. */
const FIELDS: readonly Field[] = ['currentPassword', 'newPassword', 'repeat'];

const MISMATCH = 'The new passwords do not match.';

/**
 * Change your own password: the current one, the new one, and the new one
 * again. Used twice — the forced step at first sign-in (`ChoosePassword`) and
 * the account menu's Change password page — which is why it owns no heading
 * and no navigation: each caller says where it is and decides what `onDone`
 * means.
 *
 * ═══ REFUSED HERE BEFORE THE SERVER SEES IT ═══
 *
 * The repeat field is this form's own check and never leaves it — the server's
 * schema is strict, so it is not sent. Two new passwords that differ are
 * refused under the repeat field, and the two that are sent are parsed with
 * `ChangePasswordRequestSchema`, each issue shown under the field its path
 * names, in the words `formIssues` chooses (a password bound as one sentence,
 * never zod's own English). All of them at once: a reader who fixes one field
 * should not be told about the next on the following press.
 *
 * Each refused field is marked `aria-invalid` and described by its message,
 * and the caret moves to the first of them — in an effect, after the commit,
 * so a screen reader reaches the field already marked (`ProjectRules` records
 * why the handler is too early).
 *
 * ═══ THE SERVER'S REFUSAL IS SHOWN AS IT SENT IT ═══
 *
 * The current password is checked against the stored hash, which only the
 * server holds, so `INVALID_CURRENT_PASSWORD` can only come back from it. A
 * `ProblemError` is shown in the same `role="alert"` block `NewProject` uses,
 * detail then remediation, and the fields keep what was typed.
 *
 * `onDone` may return a promise, and the button stays busy until it settles:
 * TanStack awaits a mutation's `onSuccess` before the mutation stops being
 * pending, so a caller that refetches before moving on keeps the form from
 * being pressed again over a password that has just stopped being current.
 */
export default function PasswordChangeForm({ onDone }: { readonly onDone: () => void | Promise<void> }) {
  const base = useId();
  const idOf = (field: Field): string => `${base}-${field}`;

  const [values, setValues] = useState<Record<Field, string>>({ currentPassword: '', newPassword: '', repeat: '' });
  /* A FRESH OBJECT on every refusal, so pressing again over the same mistake
     re-runs the focus effect and pulls the caret back. */
  const [refused, setRefused] = useState<{ readonly fields: Partial<Record<Field, string>>; readonly form: string | null } | null>(
    null,
  );

  const mutation = useMutation({
    mutationFn: changeOwnPassword,
    onSuccess: () => onDone(),
  });

  useEffect(() => {
    if (refused === null) return;
    const first = FIELDS.find((field) => refused.fields[field] !== undefined);
    if (first !== undefined) document.getElementById(`${base}-${first}`)?.focus();
  }, [refused, base]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mutation.isPending) return;
    // A refusal from the last press describes a request this one replaces.
    mutation.reset();

    const parsed = ChangePasswordRequestSchema.safeParse({
      currentPassword: values.currentPassword,
      newPassword: values.newPassword,
    });
    const fields: Partial<Record<Field, string>> = {};
    let form: string | null = null;
    if (!parsed.success) {
      for (const [key, message] of Object.entries(fieldMessages(parsed.error.issues))) {
        if (key === 'currentPassword' || key === 'newPassword') fields[key] = message;
        // An issue naming no field of this form (none can today) is still said.
        else form ??= message;
      }
    }
    if (values.repeat !== values.newPassword) fields.repeat = MISMATCH;

    if (!parsed.success || fields.repeat !== undefined) {
      setRefused({ fields, form });
      return;
    }
    setRefused(null);
    mutation.mutate(parsed.data);
  };

  const fieldError = (field: Field): string | undefined => refused?.fields[field];
  const problem = mutation.error instanceof ProblemError ? mutation.error : null;
  const formMessage = refused?.form ?? null;

  const input = (field: Field, autoComplete: 'current-password' | 'new-password') => {
    const error = fieldError(field);
    return (
      <input
        id={idOf(field)}
        type="password"
        autoComplete={autoComplete}
        className={INPUT}
        value={values[field]}
        onChange={(event) => {
          const next = event.target.value;
          setValues((current) => ({ ...current, [field]: next }));
        }}
        required
        aria-invalid={error !== undefined || undefined}
        aria-describedby={error === undefined ? undefined : errorId(idOf(field))}
      />
    );
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <FormField label="Current password" id={idOf('currentPassword')} error={fieldError('currentPassword')}>
        {input('currentPassword', 'current-password')}
      </FormField>
      <FormField label="New password" id={idOf('newPassword')} error={fieldError('newPassword')}>
        {input('newPassword', 'new-password')}
      </FormField>
      <FormField label="Repeat new password" id={idOf('repeat')} error={fieldError('repeat')}>
        {input('repeat', 'new-password')}
      </FormField>

      {(formMessage !== null || mutation.isError) && (
        <div role="alert" className="rounded-lg border border-default bg-sunken p-3 text-[0.8125rem] text-primary">
          {formMessage ?? problem?.detail ?? mutation.error?.message}
          {formMessage === null && problem?.remediation && <p className="mt-1 text-muted">{problem.remediation}</p>}
        </div>
      )}

      <div>
        <Button type="submit" variant="primary" loading={mutation.isPending}>
          Change password
        </Button>
      </div>
    </form>
  );
}
