import {
  useMemo,
  useState,
  type ChangeEvent,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  RunnerArtifactKind,
  RunnerJob,
  RunnerJobListResponse,
  RunnerJobLogsResponse,
  RunnerJobStatus,
  RunnerStartMetadata,
  RunnerStartResponse,
} from '@perfportal/contracts';
import Button, { linkButtonClasses } from '../components/Button';
import Card from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { ChevronLeftIcon, PlayIcon, RefreshIcon, StopIcon, UploadIcon } from '../components/icons';
import { ProblemError } from '../api/fetch';
import { fetchProjects, projectsQueryKey } from '../api/projects';
import {
  cancelRunnerJob,
  fetchRunnerJobLogs,
  fetchRunnerJobs,
  runnerJobLogsQueryKey,
  retryRunnerJob,
  runnerJobsQueryKey,
  startRunnerRun,
} from '../api/runner';
import { ROW, TABLE, TD, TH, THEAD, INPUT } from '../components/tableStyles';
import useDocumentTitle from '../useDocumentTitle';
import { projectPath, runPath } from './paths';

type FormState = {
  name: string;
  artifactKind: RunnerArtifactKind;
  simulationClass: string;
  gatlingVersion: string;
  environment: string;
  branch: string;
  commitSha: string;
  javaOptions: string;
  systemProperties: string;
};

const initialForm: FormState = {
  name: '',
  artifactKind: 'gatling_jar',
  simulationClass: '',
  gatlingVersion: '',
  environment: '',
  branch: '',
  commitSha: '',
  javaOptions: '',
  systemProperties: '',
};

const activeRunnerStatuses = new Set<RunnerJobStatus>(['queued', 'starting', 'running', 'closing']);

export default function NewRunnerRun() {
  const { slug = '' } = useParams<{ slug: string }>();
  const projects = useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });
  const project = projects.data?.items.find((p) => p.slug === slug) ?? null;
  const title = project?.name ? `New run · ${project.name}` : 'New on-prem run';
  useDocumentTitle(title);

  if (projects.isPending) {
    return <LoadingState label="Loading project…" />;
  }

  if (projects.isError) {
    const error = projects.error;
    const problem = error instanceof ProblemError ? error : null;
    return (
      <ErrorState
        titleAs="h1"
        title="The project could not be loaded"
        detail={problem?.detail ?? error.message}
        remediation={problem?.remediation}
      />
    );
  }

  if (project === null) {
    return (
      <ErrorState
        titleAs="h1"
        title="Project not found"
        detail={`No project "${slug}" is visible to this session.`}
        action={<BackToProject slug={slug} />}
      />
    );
  }

  return <NewRunnerRunProject key={slug} slug={slug} projectName={project.name} />;
}

function NewRunnerRunProject({
  slug,
  projectName,
}: {
  readonly slug: string;
  readonly projectName: string;
}) {
  const queryClient = useQueryClient();
  const jobs = useQuery({
    queryKey: runnerJobsQueryKey(slug),
    queryFn: () => fetchRunnerJobs(slug),
    enabled: slug !== '',
    refetchInterval: (query) => hasActiveRunnerJobs(query.state.data) ? 2000 : false,
  });

  const [form, setForm] = useState<FormState>(initialForm);
  const [artifact, setArtifact] = useState<File | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<RunnerStartResponse | null>(null);

  const mutation = useMutation({
    mutationFn: (metadata: RunnerStartMetadata) => {
      if (artifact === null) throw new Error('Choose a Gatling artifact before starting the run.');
      return startRunnerRun({ projectSlug: slug, metadata, artifact });
    },
    onSuccess: (response) => {
      setCreated(response);
      void queryClient.invalidateQueries({ queryKey: runnerJobsQueryKey(slug) });
    },
  });

  const artifactHint = useMemo(() => {
    if (artifact === null) return 'No artifact selected.';
    const mb = artifact.size / (1024 * 1024);
    return `${artifact.name} · ${mb < 1 ? `${Math.max(1, Math.round(artifact.size / 1024))} KB` : `${mb.toFixed(1)} MB`}`;
  }, [artifact]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setCreated(null);
    const parsedProps = parseSystemProperties(form.systemProperties);
    if (parsedProps.kind === 'error') {
      setFormError(parsedProps.message);
      return;
    }
    if (artifact === null) {
      setFormError('Choose the jar or bundle this node should run.');
      return;
    }
    setFormError(null);
    mutation.mutate({
      name: form.name.trim(),
      artifactKind: form.artifactKind,
      simulationClass: form.simulationClass.trim(),
      ...(form.gatlingVersion.trim() ? { gatlingVersion: form.gatlingVersion.trim() } : {}),
      ...(form.environment.trim() ? { environment: form.environment.trim() } : {}),
      ...(form.branch.trim() ? { branch: form.branch.trim() } : {}),
      ...(form.commitSha.trim() ? { commitSha: form.commitSha.trim() } : {}),
      ...(form.javaOptions.trim() ? { javaOptions: form.javaOptions.trim() } : {}),
      systemProperties: parsedProps.value,
    });
  };

  const mutationError = mutation.error;
  const problem = mutationError instanceof ProblemError ? mutationError : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Link to={projectPath(slug)} className="inline-flex items-center gap-1 text-[13px] font-medium text-muted hover:text-primary">
            <ChevronLeftIcon className="h-3.5 w-3.5" />
            {projectName}
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">New on-prem run</h1>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card
          title="Gatling artifact"
          description="Artifact and execution metadata."
        >
          <form className="flex flex-col gap-5" onSubmit={submit}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Run name" id="runner-name">
                <input id="runner-name" className={INPUT} value={form.name} onChange={update('name', setForm)} required />
              </Field>
              <Field label="Artifact type" id="runner-kind">
                <select id="runner-kind" className={INPUT} value={form.artifactKind} onChange={update('artifactKind', setForm)}>
                  <option value="gatling_jar">Gatling jar</option>
                  <option value="gatling_bundle">Runnable bundle</option>
                </select>
              </Field>
              <Field label="Simulation class" id="runner-simulation">
                <input
                  id="runner-simulation"
                  className={INPUT}
                  value={form.simulationClass}
                  placeholder="example.BasicSimulation"
                  onChange={update('simulationClass', setForm)}
                  required
                />
              </Field>
              <Field label="Gatling version" id="runner-gatling-version" optional>
                <input id="runner-gatling-version" className={INPUT} value={form.gatlingVersion} onChange={update('gatlingVersion', setForm)} />
              </Field>
            </div>

            <label className="flex cursor-pointer flex-col gap-2 rounded-xl border border-dashed border-default bg-sunken p-4 transition-ui hover:bg-page">
              <span className="flex items-center gap-2 text-sm font-medium text-primary">
                <UploadIcon className="h-4 w-4" />
                Artifact file
              </span>
              <span className="text-[13px] text-muted">{artifactHint}</span>
              <input
                className="sr-only"
                type="file"
                accept=".jar,.zip,.tgz,.tar.gz"
                onChange={(event) => setArtifact(event.target.files?.[0] ?? null)}
              />
            </label>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label="Environment" id="runner-environment" optional>
                <input id="runner-environment" className={INPUT} value={form.environment} onChange={update('environment', setForm)} />
              </Field>
              <Field label="Branch" id="runner-branch" optional>
                <input id="runner-branch" className={INPUT} value={form.branch} onChange={update('branch', setForm)} />
              </Field>
              <Field label="Commit SHA" id="runner-commit" optional>
                <input id="runner-commit" className={INPUT} value={form.commitSha} onChange={update('commitSha', setForm)} />
              </Field>
            </div>

            <Field label="JVM options" id="runner-java-options" optional>
              <input id="runner-java-options" className={INPUT} value={form.javaOptions} onChange={update('javaOptions', setForm)} />
            </Field>

            <Field label="System properties" id="runner-system-properties" optional>
              <textarea
                id="runner-system-properties"
                className={`${INPUT} min-h-28 resize-y py-2 font-mono`}
                value={form.systemProperties}
                placeholder={'baseUrl=https://service.internal\nusers=250'}
                onChange={update('systemProperties', setForm)}
              />
            </Field>

            {(formError !== null || mutation.isError) && (
              <div role="alert" className="rounded-lg border border-default bg-sunken p-3 text-[13px] text-primary">
                {formError ?? problem?.detail ?? mutationError?.message}
                {problem?.remediation && <p className="mt-1 text-muted">{problem.remediation}</p>}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" loading={mutation.isPending}>
                <PlayIcon className="h-3.5 w-3.5" />
                Queue run
              </Button>
            </div>
          </form>
        </Card>

        <Card title="Node policy" description="Single-node on-prem execution.">
          <dl className="grid grid-cols-1 gap-4 text-[13px]">
            <div>
              <dt className="text-muted">Concurrency</dt>
              <dd className="font-medium text-primary">One active job</dd>
            </div>
            <div>
              <dt className="text-muted">Artifact</dt>
              <dd className="font-medium text-primary">Jar or bundle</dd>
            </div>
            <div>
              <dt className="text-muted">Report</dt>
              <dd className="font-medium text-primary">Live run</dd>
            </div>
          </dl>
        </Card>
      </div>

      {created !== null && <QueuedJob response={created} />}
      <RecentJobs slug={slug} query={jobs} />
    </div>
  );
}

function Field({
  label,
  id,
  optional = false,
  children,
}: {
  readonly label: string;
  readonly id: string;
  readonly optional?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-primary">
        {label}
        {optional && <span className="ml-1 font-normal text-muted">optional</span>}
      </label>
      {children}
    </div>
  );
}

function QueuedJob({ response }: { readonly response: RunnerStartResponse }) {
  return (
    <Card title="Run queued">
      <dl className="grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-3">
        <div>
          <dt className="text-muted">Job</dt>
          <dd className="font-mono text-primary">{response.job.id.slice(0, 8)}</dd>
        </div>
        <div>
          <dt className="text-muted">Artifact</dt>
          <dd className="truncate text-primary">{response.artifact.filename}</dd>
        </div>
        <div>
          <dt className="text-muted">Status</dt>
          <dd className="text-primary">{response.job.status}</dd>
        </div>
      </dl>
      {response.job.runId !== null && (
        <Link to={runPath(response.job.runId)} className={linkButtonClasses}>
          Open live report
        </Link>
      )}
    </Card>
  );
}

function RecentJobs({ slug, query }: { readonly slug: string; readonly query: UseQueryResult<RunnerJobListResponse, Error> }) {
  const queryClient = useQueryClient();
  const [selectedLogJobId, setSelectedLogJobId] = useState<string | null>(null);
  const logs = useQuery({
    queryKey: runnerJobLogsQueryKey(slug, selectedLogJobId),
    queryFn: () => fetchRunnerJobLogs(slug, selectedLogJobId!),
    enabled: slug !== '' && selectedLogJobId !== null,
    refetchInterval: selectedLogJobId === null ? false : 2000,
  });
  const cancelMutation = useMutation({
    mutationFn: (jobId: string) => cancelRunnerJob(slug, jobId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: runnerJobsQueryKey(slug) });
    },
  });
  const retryMutation = useMutation({
    mutationFn: (jobId: string) => retryRunnerJob(slug, jobId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: runnerJobsQueryKey(slug) });
    },
  });

  if (query.isPending) return <LoadingState label="Loading runner jobs…" />;
  if (query.isError) {
    const error = query.error;
    const problem = error instanceof ProblemError ? error : null;
    return (
      <ErrorState
        title="Runner jobs could not be loaded"
        detail={problem?.detail ?? error.message}
        remediation={problem?.remediation}
      />
    );
  }
  if (query.data.items.length === 0) {
    return <EmptyState title="No on-prem runs yet" body="Queued runner jobs for this project will appear here." />;
  }
  const caption = 'Most recent on-prem runner jobs for this project.';
  return (
    <div className="flex flex-col gap-4">
      <TableFrame caption={caption} label="On-prem runner jobs table">
        <table className={TABLE}>
          <caption className="sr-only">{caption}</caption>
          <thead className={THEAD}>
            <tr>
              <th scope="col" className={TH}>Created</th>
              <th scope="col" className={TH}>Artifact</th>
              <th scope="col" className={TH}>Simulation</th>
              <th scope="col" className={TH}>Status</th>
              <th scope="col" className={TH}>Report</th>
              <th scope="col" className={TH}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {query.data.items.map(({ artifact, job }) => (
              <tr key={job.id} className={ROW}>
                <td className={TD}>{new Date(job.createdAt).toLocaleString()}</td>
                <td className={TD}>{artifact.filename}</td>
                <td className={TD}>{artifact.simulationClass}</td>
                <td className={TD}>{job.status}</td>
                <td className={TD}>
                  {job.runId === null ? (
                    <span className="text-muted">Waiting for runner</span>
                  ) : (
                    <Link to={runPath(job.runId)} className="font-medium text-accent hover:underline">
                      Open report
                    </Link>
                  )}
                </td>
                <td className={TD}>
                  <RunnerJobActions
                    job={job}
                    cancelling={cancelMutation.isPending && cancelMutation.variables === job.id}
                    retrying={retryMutation.isPending && retryMutation.variables === job.id}
                    logsSelected={selectedLogJobId === job.id}
                    onCancel={() => cancelMutation.mutate(job.id)}
                    onRetry={() => retryMutation.mutate(job.id)}
                    onLogs={() => setSelectedLogJobId((current) => current === job.id ? null : job.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
      {selectedLogJobId !== null && <RunnerLogsPanel jobId={selectedLogJobId} query={logs} />}
    </div>
  );
}

function hasActiveRunnerJobs(data: RunnerJobListResponse | undefined): boolean {
  return data?.items.some(({ job }) => activeRunnerStatuses.has(job.status)) ?? false;
}

function RunnerJobActions({
  job,
  cancelling,
  retrying,
  logsSelected,
  onCancel,
  onRetry,
  onLogs,
}: {
  readonly job: RunnerJob;
  readonly cancelling: boolean;
  readonly retrying: boolean;
  readonly logsSelected: boolean;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onLogs: () => void;
}) {
  const logsButton = (
    <Button size="sm" variant="ghost" onClick={onLogs}>
      {logsSelected ? 'Hide logs' : 'Logs'}
    </Button>
  );
  if (job.status === 'queued' || job.status === 'starting' || job.status === 'running') {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {logsButton}
        <Button size="sm" variant="ghost" loading={cancelling} onClick={onCancel}>
          <StopIcon className="h-3.5 w-3.5" />
          Cancel
        </Button>
      </div>
    );
  }
  if (job.status === 'failed' || job.status === 'cancelled') {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {logsButton}
        <Button size="sm" variant="ghost" loading={retrying} onClick={onRetry}>
          <RefreshIcon className="h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    );
  }
  return logsButton;
}

function RunnerLogsPanel({
  jobId,
  query,
}: {
  readonly jobId: string;
  readonly query: UseQueryResult<RunnerJobLogsResponse, Error>;
}) {
  const problem = query.error instanceof ProblemError ? query.error : null;
  return (
    <Card title="Runner logs" description={jobId.slice(0, 8)}>
      {query.isPending && <LoadingState label="Loading runner logs…" />}
      {query.isError && (
        <ErrorState
          title="Runner logs could not be loaded"
          detail={problem?.detail ?? query.error.message}
          remediation={problem?.remediation}
        />
      )}
      {query.isSuccess && (
        <div className="flex flex-col gap-2">
          {query.data.truncated && <p className="text-[13px] text-muted">Showing the latest 256 KB.</p>}
          <pre className="max-h-96 overflow-auto rounded-lg border border-default bg-sunken p-3 font-mono text-xs leading-relaxed text-primary">
            {query.data.text || 'No logs yet.'}
          </pre>
        </div>
      )}
    </Card>
  );
}

function BackToProject({ slug }: { readonly slug: string }) {
  return (
    <Link to={projectPath(slug)} className={linkButtonClasses}>
      <ChevronLeftIcon className="h-3.5 w-3.5" />
      Back to project
    </Link>
  );
}

function update<K extends keyof FormState>(
  key: K,
  setForm: Dispatch<SetStateAction<FormState>>,
) {
  return (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value as FormState[K] }));
}

function parseSystemProperties(raw: string):
  | { kind: 'ok'; value: Record<string, string> }
  | { kind: 'error'; message: string } {
  const value: Record<string, string> = {};
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      return { kind: 'error', message: `System property line ${index + 1} must be key=value.` };
    }
    value[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return { kind: 'ok', value };
}
