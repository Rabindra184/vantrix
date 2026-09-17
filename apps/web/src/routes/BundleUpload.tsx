import { useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import Button from '../components/Button';
import { ProblemError } from '../api/fetch';
import { POLL_INTERVAL_MS } from '../api/run';
import { BUNDLE_EXTENSIONS, bundleProblem, formatBytes, uploadBundle } from '../api/uploadBundle';
import { runPath } from './paths';
import { useRunTerminal } from './useRunWindow';

/**
 * The browser file picker M05 asks for.
 *
 * ═══ THE FINDING'S FOUR REQUIREMENTS, EACH A DISTINCT STATE ═══
 *
 * "a real file picker with accepted formats, validation, progress, and
 * processing state". Those are not decoration on an upload button — they are
 * four different things the reader needs to be told, at four different moments:
 *
 *   accepted formats  named BEFORE a file is chosen, not after it is refused
 *   validation        locally, before spending minutes uploading a wrong file
 *   progress          while bytes move, which is the only slow part
 *   processing state  AFTER the 202, because ingest is asynchronous and an
 *                     upload that "succeeded" is not yet a run anyone can read
 *
 * That last one is the one an upload control usually gets wrong. `POST` answers
 * 202 with a `pending` run: the bytes are stored and the worker has not parsed
 * them. Stopping at "Uploaded" would hand the reader a success message and no
 * run, so this keeps asking until the run is terminal and only then offers the
 * link.
 *
 * ═══ WHY IT COULD NOT EXIST UNTIL NOW ═══
 *
 * `POST /v1/runs` refuses a session — it reads `tenant.projectId`, which a
 * browser session does not have. `POST /v1/projects/:slug/runs` is the route
 * added with this finding; see `project-ingest.controller.ts`.
 */
export default function BundleUpload({ slug }: { readonly slug: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ detail: string; remediation: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* The processing half — `useRunTerminal`, the SAME hook every tab of the run
     page uses, rather than a second reading of run state living here. It stops
     polling the moment the run is terminal: a page that kept a 5-second timer
     open on a finished run is the "ten charts must not contribute ten live
     regions" mistake wearing a different hat. */
  const { detail, terminal } = useRunTerminal(runId ?? undefined, {
    refetchInterval: (query) => (query.state.data?.state === 'ready' ? false : POLL_INTERVAL_MS),
  });
  const status = detail.data?.run.status;

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    setFailure(null);
    setRunId(null);
    setProgress(null);
    setFile(picked);
    // Validated on SELECTION, not on submit: the reader finds out while their
    // attention is still on the file they just picked.
    setProblem(picked ? bundleProblem(picked) : null);
  };

  const upload = async () => {
    if (!file || problem !== null) return;
    setFailure(null);
    setProgress(0);
    try {
      const accepted = await uploadBundle(slug, file, { onProgress: setProgress });
      setRunId(accepted.id);
    } catch (err) {
      setProgress(null);
      setFailure(
        err instanceof ProblemError
          ? { detail: err.detail, remediation: err.remediation }
          : { detail: err instanceof Error ? err.message : 'The upload failed.', remediation: '' },
      );
    }
  };

  const uploading = progress !== null && runId === null;

  return (
    <div className="flex flex-col gap-3" data-testid="bundle-upload">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          data-testid="bundle-file"
          // The formats, on the control itself: the OS picker greys out
          // everything else, so the constraint is expressed where the choice is
          // made rather than as prose somebody has already scrolled past.
          accept={BUNDLE_EXTENSIONS.join(',')}
          className="min-w-0 max-w-full text-[0.8125rem] text-primary file:mr-3 file:rounded-md file:border file:border-default file:bg-surface file:px-3 file:py-1.5 file:text-[0.8125rem] file:text-primary"
          onChange={choose}
          disabled={uploading}
        />
        <Button
          variant="primary"
          onClick={() => void upload()}
          disabled={file === null || problem !== null || uploading || runId !== null}
          loading={uploading}
        >
          Upload bundle
        </Button>
      </div>

      <p className="text-[0.75rem] text-muted">
        A gzipped Gatling results directory ({BUNDLE_EXTENSIONS.join(' or ')}), up to 512 MB.
      </p>

      {problem !== null && (
        // `alert`, because the reader did something and needs telling now. The
        // empty/format/size messages are distinct for the reason
        // `bundleProblem` argues: they send you to check different things.
        <p
          role="alert"
          data-testid="bundle-invalid"
          className="text-[0.8125rem]"
          /* `var()` in a style, not a `text-status-failed` utility: the status
             tokens are declared on `:root` rather than inside `@theme inline`,
             so Tailwind generates NO class for them and that spelling emits
             nothing at all, silently. `TimeBrush`'s window error reaches the
             same token the same way, for the same reason. */
          style={{ color: 'var(--color-status-failed)' }}
        >
          {problem}
        </p>
      )}

      {file !== null && problem === null && runId === null && (
        <p className="text-[0.8125rem] text-muted">
          {file.name} · {formatBytes(file.size)}
        </p>
      )}

      {uploading && (
        <div data-testid="bundle-progress">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((progress ?? 0) * 100)}
            aria-label="Upload progress"
            className="h-1.5 w-full overflow-hidden rounded-full bg-sunken"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width]"
              style={{ width: `${String(Math.round((progress ?? 0) * 100))}%` }}
            />
          </div>
          <p className="mt-1 text-[0.75rem] text-muted">
            Uploading {formatBytes(file?.size ?? 0)} — {Math.round((progress ?? 0) * 100)}%
          </p>
        </div>
      )}

      {/* ═══ THE STATE AN UPLOAD CONTROL USUALLY OMITS ═══
          202 means stored, not parsed. Saying "Uploaded" here and stopping
          would report success for a run that does not exist yet. */}
      {runId !== null && !terminal && (
        <p role="status" data-testid="bundle-processing" className="text-[0.8125rem] text-muted">
          Uploaded. PerfPortal is parsing the bundle — this usually takes a few seconds.
        </p>
      )}

      {runId !== null && terminal && (
        <p role="status" data-testid="bundle-done" className="text-[0.8125rem] text-primary">
          {status === 'complete' ? 'Parsed.' : `Finished as ${String(status)}.`}{' '}
          <Link className="underline underline-offset-2" to={runPath(runId)}>
            Open the run
          </Link>
        </p>
      )}

      {failure !== null && (
        <div role="alert" data-testid="bundle-failed" className="rounded-lg border border-default bg-sunken p-3 text-[0.8125rem] text-primary">
          {/* The server's own sentence, never an invented one. */}
          {failure.detail}
          {failure.remediation !== '' && <p className="mt-1 text-muted">{failure.remediation}</p>}
        </div>
      )}
    </div>
  );
}
