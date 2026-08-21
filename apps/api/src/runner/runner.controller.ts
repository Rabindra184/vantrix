import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Controller, Get, Inject, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  RunnerJobActionResponseSchema,
  RunnerJobListResponseSchema,
  RunnerJobLogsResponseSchema,
  RunnerStartMetadataSchema,
  RunnerStartResponseSchema,
  type RunnerJobActionResponse,
  type RunnerJobListResponse,
  type RunnerJobLogsResponse,
  type RunnerStartResponse,
} from '@perfportal/contracts';
import { ProjectRepository, RunnerRepository, type ProjectRecord } from '@perfportal/persistence';
import { CONFIG } from '../auth/auth.module.js';
import { Scopes } from '../auth/scopes.decorator.js';
import { badRequest, uuidParam } from '../common/validation.js';
import type { AppConfig } from '../config.js';
import { readRunnerMultipart } from './runner.multipart.js';

@Controller('/v1/projects/:slug/runner')
export class RunnerController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly projects: ProjectRepository,
    private readonly runner: RunnerRepository,
  ) {}

  @Post('runs')
  @Scopes('runner')
  async start(
    @Param('slug') slug: string,
    @Req() req: Request,
  ): Promise<RunnerStartResponse> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, tenant.projectId, slug);

    const artifactId = randomUUID();
    const jobId = randomUUID();
    const dir = path.resolve(this.config.runner.artifactDir, tenant.orgId, project.id);
    await mkdir(dir, { recursive: true });
    const tmpPath = path.join(dir, `${artifactId}.part`);
    const upload = await readRunnerMultipart(req, tmpPath, this.config.runner.maxArtifactBytes);

    let rawMetadata: unknown;
    try {
      rawMetadata = parseMetadata(upload.metadataRaw);
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }

    const metadata = RunnerStartMetadataSchema.safeParse(rawMetadata);
    if (!metadata.success) {
      await unlink(tmpPath).catch(() => undefined);
      throw badRequest(
        'INVALID_RUNNER_METADATA',
        `Invalid runner metadata: ${metadata.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        'Send metadata with name, artifactKind and simulationClass. See /v1/openapi.json for the full schema.',
      );
    }

    const filename = sanitizeFilename(upload.filename);
    let ext: string;
    try {
      ext = extensionFor(filename, metadata.data.artifactKind);
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
    const relativeStoragePath = path.join(tenant.orgId, project.id, `${artifactId}${ext}`);
    const finalPath = path.resolve(this.config.runner.artifactDir, relativeStoragePath);
    try {
      await rename(tmpPath, finalPath);
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }

    let created: Awaited<ReturnType<RunnerRepository['createQueued']>>;
    try {
      created = await this.runner.createQueued({
        artifact: {
          id: artifactId,
          orgId: tenant.orgId,
          projectId: project.id,
          name: metadata.data.name,
          filename,
          kind: metadata.data.artifactKind,
          simulationClass: metadata.data.simulationClass,
          gatlingVersion: metadata.data.gatlingVersion ?? null,
          sha256: upload.sha256,
          bytes: upload.bytes,
          storagePath: relativeStoragePath,
        },
        job: {
          id: jobId,
          requestedBy: tenant.tokenId,
          environment: metadata.data.environment ?? null,
          branch: metadata.data.branch ?? null,
          commitSha: metadata.data.commitSha ?? null,
          javaOptions: metadata.data.javaOptions ?? null,
          systemProperties: metadata.data.systemProperties,
        },
      });
    } catch (err) {
      await unlink(finalPath).catch(() => undefined);
      throw err;
    }

    return RunnerStartResponseSchema.parse({
      artifact: toArtifact(created.artifact),
      job: toJob(created.job),
      next: {
        reportUrl: created.job.runId === null ? null : `/runs/${created.job.runId}`,
        runner:
          'Queued on this on-prem node. The local runner process should claim this job, start Gatling, stream simulation.log into /v1/runs/live, and attach the resulting run id.',
      },
    });
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
      items: rows.map((row) => ({ artifact: toArtifact(row.artifact), job: toJob(row.job) })),
    });
  }

  @Post('runs/:jobId/cancel')
  @Scopes('runner')
  async cancel(
    @Param('slug') slug: string,
    @Param('jobId', uuidParam('jobId')) jobId: string,
    @Req() req: Request,
  ): Promise<RunnerJobActionResponse> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, tenant.projectId, slug);
    const row = await this.runner.cancel(tenant.orgId, project.id, jobId);
    if (!row) throw new NotFoundException(`No cancellable runner job ${jobId} in this project.`);
    return RunnerJobActionResponseSchema.parse({ artifact: toArtifact(row.artifact), job: toJob(row.job) });
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
    if (!row) throw new NotFoundException(`No runner job ${jobId} in this project.`);

    const content = row.job.logPath ? await readLogTail(row.job.logPath, 256 * 1024) : null;
    return RunnerJobLogsResponseSchema.parse({
      jobId,
      text: content?.text ?? '',
      truncated: content?.truncated ?? false,
      updatedAt: content?.updatedAt?.toISOString() ?? null,
    });
  }

  @Post('runs/:jobId/retry')
  @Scopes('runner')
  async retry(
    @Param('slug') slug: string,
    @Param('jobId', uuidParam('jobId')) jobId: string,
    @Req() req: Request,
  ): Promise<RunnerJobActionResponse> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, tenant.projectId, slug);
    const row = await this.runner.retry({
      id: randomUUID(),
      orgId: tenant.orgId,
      projectId: project.id,
      sourceJobId: jobId,
      requestedBy: tenant.tokenId,
    });
    if (!row) throw new NotFoundException(`No retryable runner job ${jobId} in this project.`);
    return RunnerJobActionResponseSchema.parse({ artifact: toArtifact(row.artifact), job: toJob(row.job) });
  }

  private async resolveProject(
    orgId: string,
    credentialProjectId: string | undefined,
    slug: string,
  ): Promise<ProjectRecord> {
    const project = await this.projects.findBySlugInOrg(orgId, slug);
    if (!project || (credentialProjectId !== undefined && credentialProjectId !== project.id)) {
      throw new NotFoundException(`No project "${slug}" in this organisation.`);
    }
    return project;
  }
}

function parseMetadata(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest(
      'INVALID_RUNNER_METADATA',
      'Runner metadata must be valid JSON.',
      'Send a JSON "metadata" multipart field before the artifact file.',
    );
  }
}

function extensionFor(filename: string, kind: string): string {
  const lower = filename.toLowerCase();
  const ext = lower.endsWith('.tar.gz') ? '.tar.gz' : path.extname(lower);
  const allowed = kind === 'gatling_jar' ? new Set(['.jar']) : new Set(['.zip', '.tgz', '.tar.gz']);
  if (ext === '') return kind === 'gatling_jar' ? '.jar' : '.zip';
  if (allowed.has(ext)) return ext;
  throw badRequest(
    'UNSUPPORTED_RUNNER_ARTIFACT_EXTENSION',
    `Runner artifact "${filename}" is not a supported ${kind} upload.`,
    kind === 'gatling_jar'
      ? 'Upload a .jar file, or choose the runnable bundle artifact type.'
      : 'Upload a .zip, .tgz, or .tar.gz runnable bundle, or choose the Gatling jar artifact type.',
  );
}

function sanitizeFilename(filename: string): string {
  return path.basename(filename).replace(/[^\w.\- ]/g, '_') || 'gatling-artifact';
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

function toArtifact(artifact: {
  id: string;
  name: string;
  filename: string;
  kind: string;
  simulationClass: string;
  gatlingVersion: string | null;
  sha256: string;
  bytes: number;
  createdAt: Date;
}) {
  return {
    id: artifact.id,
    name: artifact.name,
    filename: artifact.filename,
    kind: artifact.kind,
    simulationClass: artifact.simulationClass,
    gatlingVersion: artifact.gatlingVersion,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    createdAt: artifact.createdAt.toISOString(),
  };
}

function toJob(job: {
  id: string;
  artifactId: string;
  runId: string | null;
  status: string;
  requestedBy: string;
  environment: string | null;
  branch: string | null;
  commitSha: string | null;
  javaOptions: string | null;
  systemProperties: Record<string, string>;
  error: { code: string; message: string; remediation: string } | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: job.id,
    artifactId: job.artifactId,
    runId: job.runId,
    status: job.status,
    requestedBy: job.requestedBy,
    environment: job.environment,
    branch: job.branch,
    commitSha: job.commitSha,
    javaOptions: job.javaOptions,
    systemProperties: job.systemProperties,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
