import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  RunnerJobActionResponseSchema,
  RunnerJobListResponseSchema,
  RunnerJobLogsResponseSchema,
  RunnerStartByPackageRequestSchema,
  RunnerStartMetadataSchema,
  RunnerStartResponseSchema,
  type RunnerArtifactKind,
  type RunnerJobActionResponse,
  type RunnerJobListResponse,
  type RunnerJobLogsResponse,
  type RunnerStartMetadata,
  type RunnerStartResponse,
} from '@perfportal/contracts';
import {
  PackageNameTakenError,
  PackageRepository,
  ProjectRepository,
  RunnerRepository,
  type PackageRecord,
  type PackageVersionRecord,
  type ProjectRecord,
  type RunnerArtifactRecord,
  type RunnerJobRecord,
  type RunnerJobWithArtifact,
} from '@perfportal/persistence';
import { CONFIG } from '../auth/auth.module.js';
import { Scopes } from '../auth/scopes.decorator.js';
import { badRequest, conflict, notFound, projectNotFound, uuidParam } from '../common/validation.js';
import type { AppConfig } from '../config.js';
import {
  assertSimulationListed,
  emptyFile,
  extensionFor,
  inspectArtifact,
  packageNameFromFilename,
  packageNotFound,
  sanitizeFilename,
} from './package-files.js';
import { readRunnerMultipart } from './runner.multipart.js';

@Controller('/v1/projects/:slug/runner')
export class RunnerController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly projects: ProjectRepository,
    private readonly runner: RunnerRepository,
    private readonly packages: PackageRepository,
  ) {}

  @Post('runs')
  @Scopes('runner')
  async start(@Param('slug') slug: string, @Req() req: Request): Promise<RunnerStartResponse> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, tenant.projectId, slug);
    // Two bodies, one route (the spec): JSON starts from a package with no
    // upload; multipart is the upload-and-start every existing caller sends.
    // req.is reads Content-Type; Express's json() has parsed a JSON body
    // into req.body by now, and left a multipart one untouched for busboy.
    if (req.is('application/json')) return this.startFromPackage(req, project);
    return this.startFromUpload(req, project);
  }

  /**
   * A run from a package's CURRENT version, as this request reads it. Nothing
   * is uploaded and nothing is written: the job is queued on the version row
   * the package points at.
   */
  private async startFromPackage(req: Request, project: ProjectRecord): Promise<RunnerStartResponse> {
    const tenant = req.tenant!;
    // `.strict()`: a JSON body carrying artifactKind or gatlingVersion is a
    // caller who thinks it is uploading, and is told so rather than ignored.
    const parsed = RunnerStartByPackageRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_RUNNER_METADATA',
        `Invalid runner start: ${describeIssues(parsed.error.issues, 'body')}`,
        'Send a JSON body with packageId, name and simulationClass to start from a package, or POST ' +
          'multipart/form-data with a "metadata" part and an "artifact" file to upload one. See ' +
          '/v1/openapi.json for the full schema.',
      );
    }
    const body = parsed.data;

    const pkg = await this.packages.find(tenant.orgId, project.id, body.packageId);
    if (!pkg) throw packageNotFound(body.packageId);
    if (pkg.current === null) {
      throw conflict(
        'PACKAGE_HAS_NO_FILE',
        `Package "${pkg.name}" has no file to run yet.`,
        'Upload one with PUT /v1/projects/{slug}/packages/{packageId}/content, then start the run.',
      );
    }
    assertSimulationListed(pkg.current.simulations, body.simulationClass);

    const created = await this.runner.createQueued({
      orgId: tenant.orgId,
      projectId: project.id,
      artifactId: pkg.current.artifactId,
      job: { id: randomUUID(), requestedBy: tenant.tokenId, ...jobFields(body) },
    });
    // Null means ONE thing: the package was deleted between the read above and
    // the queue (a delete holds the package FOR UPDATE, which wins against the
    // start's FOR SHARE). Every other miss throws, and surfaces as itself.
    if (created === null) throw packageNotFound(body.packageId);
    return startedResponse(created);
  }

  /**
   * The upload-and-start: the file becomes a VERSION of a package — the one the
   * metadata's "package" names, or the one its filename stem names — and the
   * job is queued on that version.
   *
   * ═══ WHO REMOVES THE FILE, AND WHEN ═══
   *
   * Until a version row names the file, every failure removes it: nothing else
   * knows it exists. From the moment `addVersion` commits, the row does, so no
   * failure after that removes it — the version is a real one of its package
   * whether or not a job ever runs it, and a retry of the same bytes reuses it.
   * The one file removed after that point is the DUPLICATE, when the package
   * already held these bytes and `addVersion` made the earlier version current
   * instead of storing this one.
   */
  private async startFromUpload(req: Request, project: ProjectRecord): Promise<RunnerStartResponse> {
    const tenant = req.tenant!;
    const artifactId = randomUUID();
    const dir = path.resolve(this.config.runner.artifactDir, tenant.orgId, project.id);
    await mkdir(dir, { recursive: true });
    const tmpPath = path.join(dir, `${artifactId}.part`);
    // readRunnerMultipart removes its own partial file when it fails.
    const upload = await readRunnerMultipart(req, tmpPath, this.config.runner.maxArtifactBytes, {
      fileRequired: true,
    });

    let finalPath: string | null = null;
    let filed: { metadata: RunnerStartMetadata; packageId: string; version: PackageVersionRecord; reused: boolean };
    try {
      // First, inside the try so the empty file goes too: a bundle is never
      // inspected, so an empty one would otherwise become a package's current
      // version and fail on the runner minutes later.
      if (upload.bytes === 0) throw emptyFile('runner-start');
      const metadata = parseStartMetadata(upload.metadataRaw);
      const filename = sanitizeFilename(upload.filename);
      // 'request': the kind is this upload's own "artifactKind", not a package's.
      const ext = extensionFor(filename, metadata.artifactKind, 'request');
      const storagePath = path.join(tenant.orgId, project.id, `${artifactId}${ext}`);
      finalPath = path.resolve(this.config.runner.artifactDir, storagePath);
      await rename(tmpPath, finalPath);
      const facts = await inspectArtifact(finalPath, metadata.artifactKind);
      // EVERYTHING THAT CAN REFUSE THE FILE HAPPENS BEFORE A PACKAGE IS FOUND OR
      // MADE: a jar that is not a jar, or one that does not declare the class,
      // must not leave behind a package named after it.
      assertSimulationListed(facts.simulations, metadata.simulationClass);

      const pkg = await this.packageForUpload(
        tenant.orgId,
        project.id,
        metadata.package ?? packageNameFromFilename(filename),
        metadata.artifactKind,
      );
      const added = await this.packages.addVersion(tenant.orgId, project.id, pkg.id, {
        artifactId,
        filename,
        // What the jar's own manifest says, when it says anything; otherwise
        // (a bundle, or a jar with no Gatling-Version) what the requester said.
        gatlingVersion: facts.gatlingVersion ?? metadata.gatlingVersion ?? null,
        sha256: upload.sha256,
        bytes: upload.bytes,
        simulations: facts.simulations,
        storagePath,
      });
      // Deleted between the lookup and the version: no row was made, so the
      // file is still only this request's, and the catch removes it.
      if (added === null) throw packageNotFound(pkg.id);
      filed = { metadata, packageId: pkg.id, version: added.version, reused: added.reused };
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      if (finalPath !== null) await unlink(finalPath).catch(() => undefined);
      throw err;
    }

    // The package already held these bytes: the EARLIER version was made current
    // and is the one the job runs, and the file just written is the duplicate.
    // Its row was never created, so nothing names it.
    if (filed.reused && finalPath !== null) await unlink(finalPath).catch(() => undefined);

    const created = await this.runner.createQueued({
      orgId: tenant.orgId,
      projectId: project.id,
      // THE VERSION THIS UPLOAD MADE CURRENT, never the package's current as
      // anything reads it now: a concurrent upload may already have replaced
      // it, and a run must start from the jar this request carried.
      artifactId: filed.version.artifactId,
      job: { id: randomUUID(), requestedBy: tenant.tokenId, ...jobFields(filed.metadata) },
    });
    // A package delete won the race after addVersion committed. The file is
    // deliberately NOT removed here: the version row still names it, and the
    // delete — which locked the package after that row existed — handed its
    // storage path back to the DELETE handler, which removes it. Removing it
    // here too would only race that handler for the same file.
    if (created === null) throw packageNotFound(filed.packageId);
    return startedResponse(created);
  }

  /**
   * The package an upload-and-start files its file in, created with the
   * upload's kind when the project has none by that name.
   *
   * THE NAME IS MATCHED BY THE DATABASE, NEVER HERE. The schema has trimmed it,
   * and `findByName` compares lower(name) — the expression the unique index is
   * declared on — so " checkout " lands in "Checkout", and a comparison here
   * could only disagree with the index that decides what a duplicate is.
   *
   * A package this creates for an upload that then fails (storing its version,
   * say) is left, empty: the next upload of that name lands in it, which is what
   * would have happened anyway.
   */
  private async packageForUpload(
    orgId: string,
    projectId: string,
    name: string,
    kind: RunnerArtifactKind,
  ): Promise<PackageRecord> {
    const byName = (): Promise<PackageRecord | null> => this.packages.findByName(orgId, projectId, name);
    let pkg = await byName();
    if (pkg === null) {
      try {
        pkg = await this.packages.create({ id: randomUUID(), orgId, projectId, name, kind });
      } catch (err) {
        if (!(err instanceof PackageNameTakenError)) throw err;
        // Another start (or a person) took the name between the lookup and the
        // insert. That package is this one.
        pkg = await byName();
        // Taken and then renamed or deleted again within this one request. A
        // 500 is the honest answer, and its own advice — retry — is the right
        // one: the next attempt finds or creates whatever holds the name then.
        if (pkg === null) {
          throw new Error(`package "${name}" was created by a concurrent request and then could not be found`);
        }
      }
    }
    if (pkg.kind !== kind) {
      throw badRequest(
        'PACKAGE_KIND_MISMATCH',
        `Package "${pkg.name}" holds ${pkg.kind}; this upload is a ${kind}.`,
        `Name a package that holds ${kind} files in the metadata's "package" field, or a new name to create one.`,
      );
    }
    return pkg;
  }

  @Get('runs')
  @Scopes('read')
  async list(
    @Param('slug') slug: string,
    @Req() req: Request,
  ): Promise<RunnerJobListResponse> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, tenant.projectId, slug);
    const rows = await this.runner.listRecent(tenant.orgId, project.id);
    return RunnerJobListResponseSchema.parse({
      items: rows.map(present),
    });
  }

  // 200, NOT Nest's 201 default for @Post: a cancel changes the state of a
  // job that already exists and creates nothing, so there is no resource for
  // a 201 to announce. Retry below keeps the default, because it does create
  // one. openapi.integration.test.ts derives every handler's status from this
  // metadata and holds the document to it.
  @Post('runs/:jobId/cancel')
  @HttpCode(200)
  @Scopes('runner')
  async cancel(
    @Param('slug') slug: string,
    @Param('jobId', uuidParam('jobId')) jobId: string,
    @Req() req: Request,
  ): Promise<RunnerJobActionResponse> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, tenant.projectId, slug);
    const row = await this.runner.cancel(tenant.orgId, project.id, jobId, { recordRequest: true });
    if (!row)
      throw notFound(`No cancellable runner job ${jobId} in this project.`, 'Only a queued or running job can be cancelled. GET /v1/projects/{slug}/runner/runs '
        + 'lists this project\u2019s jobs with their status.');
    return RunnerJobActionResponseSchema.parse(present(row));
  }

  @Get('runs/:jobId/logs')
  @Scopes('read')
  async logs(
    @Param('slug') slug: string,
    @Param('jobId', uuidParam('jobId')) jobId: string,
    @Req() req: Request,
  ): Promise<RunnerJobLogsResponse> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, tenant.projectId, slug);
    const row = await this.runner.find(tenant.orgId, project.id, jobId);
    if (!row) throw notFound(`No runner job ${jobId} in this project.`, 'Check the job id, or list the runner jobs in this project with GET /v1/projects/{slug}/runner/runs.');

    const content = row.job.logPath ? await readLogTail(row.job.logPath, 256 * 1024) : null;
    return RunnerJobLogsResponseSchema.parse({
      jobId,
      text: content?.text ?? '',
      truncated: content?.truncated ?? false,
      updatedAt: content?.updatedAt?.toISOString() ?? null,
    });
  }

  // 201, Nest's default for @Post, and it is the honest answer: the retry
  // INSERTs a new job and returns that job, complete and addressable (the
  // list carries it and its logs endpoint takes its id) before the response
  // is sent — the standard openapi.integration.test.ts's 201 list holds every
  // create to.
  @Post('runs/:jobId/retry')
  @Scopes('runner')
  async retry(
    @Param('slug') slug: string,
    @Param('jobId', uuidParam('jobId')) jobId: string,
    @Req() req: Request,
  ): Promise<RunnerJobActionResponse> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, tenant.projectId, slug);
    const result = await this.runner.retry({
      id: randomUUID(),
      orgId: tenant.orgId,
      projectId: project.id,
      sourceJobId: jobId,
      requestedBy: tenant.tokenId,
    });
    switch (result.kind) {
      case 'retried':
        return RunnerJobActionResponseSchema.parse(present(result.row));
      case 'not_retryable':
        throw notFound(`No retryable runner job ${jobId} in this project.`, 'Only a failed or cancelled job can be retried. GET /v1/projects/{slug}/runner/runs '
          + 'lists this project\u2019s jobs with their status.');
      case 'package_deleted':
        // A retry runs the VERSION the failed job ran, and that version's file
        // went with its package. Nothing here may suggest that a new package of
        // the same name brings it back: it does not, the job names the old
        // package's version.
        throw conflict(
          'PACKAGE_DELETED',
          'The package this job ran was deleted, so it cannot run again.',
          'Start a new run from a package with POST /v1/projects/{slug}/runner/runs.',
        );
    }
  }

  private async resolveProject(
    orgId: string,
    credentialProjectId: string | undefined,
    slug: string,
  ): Promise<ProjectRecord> {
    const project = await this.projects.findBySlugInOrg(orgId, slug);
    if (!project || (credentialProjectId !== undefined && credentialProjectId !== project.id)) {
      throw projectNotFound(slug);
    }
    return project;
  }
}

/** The multipart "metadata" part, parsed and validated. */
function parseStartMetadata(raw: string): RunnerStartMetadata {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw badRequest(
      'INVALID_RUNNER_METADATA',
      'Runner metadata must be valid JSON.',
      'Send a JSON "metadata" multipart field before the artifact file.',
    );
  }
  const parsed = RunnerStartMetadataSchema.safeParse(json);
  if (!parsed.success) {
    throw badRequest(
      'INVALID_RUNNER_METADATA',
      `Invalid runner metadata: ${describeIssues(parsed.error.issues, 'metadata')}`,
      'Send metadata with name, artifactKind and simulationClass. See /v1/openapi.json for the full schema.',
    );
  }
  return parsed.data;
}

/** A schema's issues as one sentence; a root-level issue (an unrecognised key,
 *  say) is named after what it was found in rather than printed with no path. */
function describeIssues(
  issues: readonly { path: readonly (string | number)[]; message: string }[],
  root: string,
): string {
  return issues.map((i) => `${i.path.join('.') || root} ${i.message}`).join('; ');
}

/**
 * The job's own fields, from either start's body: ONE spelling of the mapping,
 * so the JSON start and the upload-and-start cannot drift into carrying
 * different metadata — the trap a declared test fell into once across four
 * submit paths (CLAUDE.md, the test-per-configuration entry).
 */
function jobFields(
  meta: Pick<
    RunnerStartMetadata,
    'name' | 'simulationClass' | 'environment' | 'branch' | 'commitSha' | 'test' | 'javaOptions' | 'systemProperties'
  >,
) {
  return {
    name: meta.name,
    simulationClass: meta.simulationClass,
    environment: meta.environment ?? null,
    branch: meta.branch ?? null,
    commitSha: meta.commitSha ?? null,
    testSlug: meta.test ?? null,
    javaOptions: meta.javaOptions ?? null,
    systemProperties: meta.systemProperties,
  };
}

function startedResponse(created: RunnerJobWithArtifact): RunnerStartResponse {
  return RunnerStartResponseSchema.parse({
    ...present(created),
    next: {
      reportUrl: created.job.runId === null ? null : `/runs/${created.job.runId}`,
      runner:
        'Queued on this on-prem node. The local runner process should claim this job, start Gatling, stream simulation.log into /v1/runs/live, and attach the resulting run id.',
    },
  });
}

async function readLogTail(
  logPath: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; updatedAt: Date } | null> {
  const info = await stat(logPath).catch(() => null);
  if (!info?.isFile()) return null;

  const bytesToRead = Math.min(info.size, maxBytes);
  const start = info.size - bytesToRead;
  const handle = await open(logPath, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: start > 0,
      updatedAt: info.mtime,
    };
  } finally {
    await handle.close();
  }
}

/** A job and the version it runs, as the wire carries them. */
function present(row: RunnerJobWithArtifact) {
  return { artifact: toArtifact(row.artifact, row.job), job: toJob(row.job, row.artifact) };
}

/**
 * A version as RunnerArtifactSchema describes it. Its name and class are the
 * JOB's: one version serves many jobs, each naming its own run and class, so
 * the version row carries neither.
 */
function toArtifact(artifact: RunnerArtifactRecord, job: RunnerJobRecord) {
  return {
    id: artifact.id,
    name: job.name,
    filename: artifact.filename,
    kind: artifact.kind,
    simulationClass: job.simulationClass,
    gatlingVersion: artifact.gatlingVersion,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    createdAt: artifact.createdAt.toISOString(),
  };
}

/** The package comes from the VERSION: null once that package was deleted. */
function toJob(job: RunnerJobRecord, artifact: RunnerArtifactRecord) {
  return {
    id: job.id,
    artifactId: job.artifactId,
    runId: job.runId,
    status: job.status,
    requestedBy: job.requestedBy,
    environment: job.environment,
    branch: job.branch,
    commitSha: job.commitSha,
    testSlug: job.testSlug,
    name: job.name,
    simulationClass: job.simulationClass,
    packageId: artifact.packageId,
    packageName: artifact.packageName,
    javaOptions: job.javaOptions,
    systemProperties: job.systemProperties,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
