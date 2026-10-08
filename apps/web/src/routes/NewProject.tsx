import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreateProjectRequestSchema } from '@perfportal/contracts';
import { NoAccess } from '../access/NoAccess';
import { useAdminAccess } from '../access/useAccess';
import Button, { linkButtonClasses } from '../components/Button';
import FormField from '../components/FormField';
import Card from '../components/Card';
import { ChevronLeftIcon, PlusIcon } from '../components/icons';
import { ProblemError } from '../api/fetch';
import { createProject, projectsQueryKey } from '../api/projects';
import { INPUT } from '../components/tableStyles';
import useDocumentTitle from '../useDocumentTitle';
import { ALL_RUNS_ROUTE, DEFAULT_ROUTE, projectSetupPath } from './paths';

/**
 * The create-a-project page, whose one action — `projects:create` — only an
 * admin may take.
 *
 * ═══ THE FORM IS AN ADMIN'S; A REFUSAL IS SAID, AND ONLY ONCE KNOWN ═══
 *
 * Nothing in the app links a non-admin here any more (the run list's heading,
 * the home page's empty state and the palette all offer New project to an
 * admin alone), but a URL can still be typed or followed. Handing that reader
 * a form whose submit the API would only refuse is an offer they cannot
 * accept, so a KNOWN non-admin reads the API's own two sentences instead
 * (`NoAccess`, built by `accessRefusal`, which `AccessGuard` words its 403
 * with). While the session has not answered, nobody has been refused
 * anything: neither the form nor the refusal is drawn, and the heading and
 * the way back are — hidden until known, and no indefinite spinner over a
 * page that is otherwise ready. The API refuses either way; this is for
 * clarity.
 */
export default function NewProject() {
  useDocumentTitle('New project');
  const access = useAdminAccess();
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
        {/* "Runs" names the run list, so it goes there — `ALL_RUNS_ROUTE`, not
            the default route, which is the home page now. Cancel below is the
            other kind of link: "nowhere in particular", so it does read the
            default. */}
        <Link to={ALL_RUNS_ROUTE} className="inline-flex items-center gap-1 text-[0.8125rem] font-medium text-muted hover:text-primary">
          <ChevronLeftIcon className="h-3.5 w-3.5" />
          Runs
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">New project</h1>
      </div>

      {access.known && !access.isAdmin && <NoAccess action="projects:create" />}

      {/* No card title and no description (clean UI PR 4): "Project details"
          restated the `<h1>` and the sentence restated the fields — the
          one-title fix review M11 made to New on-prem run. */}
      {access.isAdmin && (
        <Card>
          <form className="flex flex-col gap-5" onSubmit={submit}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Project name" id="project-name">
                <input
                  id="project-name"
                  className={INPUT}
                  value={name}
                  onChange={(event) => updateName(event.target.value)}
                  required
                  autoFocus
                />
              </FormField>
              <FormField label="URL slug" id="project-slug">
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
              </FormField>
            </div>
  
            {(formError !== null || mutation.isError) && (
              <div role="alert" className="rounded-lg border border-default bg-sunken p-3 text-[0.8125rem] text-primary">
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
      )}
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
