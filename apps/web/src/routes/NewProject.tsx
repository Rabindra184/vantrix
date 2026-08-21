import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreateProjectRequestSchema } from '@perfportal/contracts';
import Button, { linkButtonClasses } from '../components/Button';
import Card from '../components/Card';
import { ChevronLeftIcon, PlusIcon } from '../components/icons';
import { ProblemError } from '../api/fetch';
import { createProject, projectsQueryKey } from '../api/projects';
import { INPUT } from '../components/tableStyles';
import useDocumentTitle from '../useDocumentTitle';
import { DEFAULT_ROUTE, projectSetupPath } from './paths';

export default function NewProject() {
  useDocumentTitle('New project');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: createProject,
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: projectsQueryKey });
      navigate(projectSetupPath(project.slug));
    },
  });

  const updateName = (value: string) => {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = CreateProjectRequestSchema.safeParse({ name, slug });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Project details are not valid.');
      return;
    }
    setFormError(null);
    mutation.mutate(parsed.data);
  };

  const mutationError = mutation.error;
  const problem = mutationError instanceof ProblemError ? mutationError : null;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <Link to={DEFAULT_ROUTE} className="inline-flex items-center gap-1 text-[13px] font-medium text-muted hover:text-primary">
          <ChevronLeftIcon className="h-3.5 w-3.5" />
          Runs
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">New project</h1>
      </div>

      <Card title="Project details" description="Name the service or application these performance runs belong to.">
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Project name" id="project-name">
              <input
                id="project-name"
                className={INPUT}
                value={name}
                onChange={(event) => updateName(event.target.value)}
                required
                autoFocus
              />
            </Field>
            <Field label="URL slug" id="project-slug">
              <input
                id="project-slug"
                className={INPUT}
                value={slug}
                placeholder="checkout-api"
                // `slugifyWhileTyping` on change and the FULL `slugify` on
                // blur, never the full one on every keystroke — see those two
                // functions for why the difference is what makes a hyphen
                // typeable at all.
                onChange={(event) => {
                  setSlugTouched(true);
                  setSlug(slugifyWhileTyping(event.target.value));
                }}
                onBlur={(event) => setSlug(slugify(event.target.value))}
                required
              />
            </Field>
          </div>

          {(formError !== null || mutation.isError) && (
            <div role="alert" className="rounded-lg border border-default bg-sunken p-3 text-[13px] text-primary">
              {formError ?? problem?.detail ?? mutationError?.message}
              {problem?.remediation && <p className="mt-1 text-muted">{problem.remediation}</p>}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" loading={mutation.isPending}>
              <PlusIcon className="h-3.5 w-3.5" />
              Create project
            </Button>
            <Link to={DEFAULT_ROUTE} className={linkButtonClasses}>
              Cancel
            </Link>
          </div>
        </form>
      </Card>
    </div>
  );
}

function Field({
  label,
  id,
  children,
}: {
  readonly label: string;
  readonly id: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-primary">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * The finished slug: what the schema has to accept.
 *
 * Safe to run on a WHOLE string at once — deriving from the project name, or
 * normalising once the reader leaves the field. It is NOT safe to run on
 * every keystroke; `slugifyWhileTyping` below is the one for that.
 */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The same normalisation MINUS the trailing-hyphen trim, for a controlled
 * input the reader is still typing into.
 *
 * THE TRIM IS WHY A HYPHEN COULD NOT BE TYPED. `slugify` ends with
 * `replace(/^-|-$/g, '')`, so running it per keystroke meant that the moment
 * the reader pressed `-`, the value handed back to the input was the string
 * WITHOUT it — the character vanished as it was typed, every time. Typing
 * `checkout-api` produced `checkoutapi`, while the field's own placeholder
 * advertised `checkout-api` and the validation message asked for "single
 * hyphens". Only the name-derived path looked right, because that slugifies a
 * whole string at once, where no hyphen is ever momentarily trailing.
 *
 * A leading hyphen and a doubled hyphen are still collapsed as you type:
 * neither can survive into a valid slug, so removing them early costs the
 * reader nothing and keeps the field showing what will actually be sent. The
 * TRAILING hyphen is the only one that is legitimately mid-word.
 */
function slugifyWhileTyping(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-/, '');
}
