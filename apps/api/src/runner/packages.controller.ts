import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  CreatePackageRequestSchema,
  PackageListResponseSchema,
  PackageSchema,
  RenamePackageRequestSchema,
  type Package,
  type PackageListResponse,
} from '@perfportal/contracts';
import { IngestError } from '@perfportal/core';
import {
  PackageNameTakenError,
  PackageRepository,
  ProjectRepository,
  type PackageWithUsage,
  type ProjectRecord,
} from '@perfportal/persistence';
import { CONFIG } from '../auth/auth.module.js';
import { Scopes } from '../auth/scopes.decorator.js';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { badRequest, conflict, notFound, uuidParam } from '../common/validation.js';
import type { AppConfig } from '../config.js';
import { emptyFile, extensionFor, inspectArtifact, packageNotFound, sanitizeFilename } from './package-files.js';
import { readRawUpload } from './raw-upload.js';
import { readRunnerMultipart } from './runner.multipart.js';

/**
 * A project's packages: named, reusable Gatling artifacts, each with a current
 * version (docs/superpowers/specs/2026-10-02-packages-design.md).
 *
 * ═══ WHICH CREDENTIAL MAY DO WHAT ═══
 *
 * Listing takes `read`; creating, uploading a version and renaming take
 * `runner`, the scope that already authorises putting executable artifacts on
 * this node. DELETE is a person's: a bearer token is refused whatever scopes it
 * carries (SessionOnlyGuard), because a delete removes the files every job
 * history on this package points at, and a leaked CI credential must not be
 * able to do that.
 *
 * ═══ A BEARER TOKEN NAMES ONE PROJECT, AND THE SLUG HAS TO AGREE ═══
 *
 * A token is minted for a project, so a slug naming a different one is 404 —
 * never 403, which would confirm the other project exists. A session names no
 * project and may reach any project in its org.
 */
@Controller('/v1/projects/:slug/packages')
export class PackagesController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly projects: ProjectRepository,
    private readonly packages: PackageRepository,
  ) {}

  @Get()
  @Scopes('read')
  async list(@Param('slug') slug: string, @Req() req: Request): Promise<PackageListResponse> {
    const project = await this.resolveProject(req, slug);
    const rows = await this.packages.list(req.tenant!.orgId, project.id);
    return PackageListResponseSchema.parse({ items: rows.map(toPackage) });
  }

  @Post()
  @HttpCode(201)
  @Scopes('runner')
  async create(@Param('slug') slug: string, @Req() req: Request): Promise<Package> {
    const project = await this.resolveProject(req, slug);
    const orgId = req.tenant!.orgId;

    const artifactId = randomUUID();
    const dir = path.resolve(this.config.runner.artifactDir, orgId, project.id);
    await mkdir(dir, { recursive: true });
    const tmpPath = path.join(dir, `${artifactId}.part`);
    let upload: Awaited<ReturnType<typeof readRunnerMultipart>>;
    try {
      upload = await readRunnerMultipart(req, tmpPath, this.config.runner.maxArtifactBytes, {
        fileRequired: false,
      });
    } catch (err) {
      // A JSON {name, kind} is the natural first attempt, and the reader's own
      // refusal talks about the RUNNER's upload. Only that one refusal is
      // re-spoken in this route's terms; every other failure is the reader's.
      if (err instanceof IngestError && err.code === 'BUNDLE_NOT_ARCHIVE') throw notMultipart();
      throw err;
    }

    // A file is whatever left a name or a byte behind. A browser form with an
    // empty file input sends a part with no name and no bytes, which is "no
    // file" and not an empty upload.
    const hasFile = upload.filename !== '' || upload.bytes > 0;
    let finalPath: string | null = null;
    const cleanup = async (): Promise<void> => {
      await unlink(tmpPath).catch(() => undefined);
      if (finalPath !== null) await unlink(finalPath).catch(() => undefined);
    };

    let createdId: string;
    try {
      const metadata = parseCreateMetadata(upload.metadataRaw);

      // EVERYTHING THAT CAN REFUSE THE FILE HAPPENS BEFORE THE PACKAGE EXISTS.
      // A jar that is not a jar must not leave behind an empty package that the
      // caller's retry then meets as "that name is taken".
      let version: { filename: string; storagePath: string; gatlingVersion: string | null; simulations: string[] | null } | null =
        null;
      if (hasFile) {
        if (upload.bytes === 0) throw emptyFile('package-create');
        const filename = sanitizeFilename(upload.filename);
        const ext = extensionFor(filename, metadata.kind, 'package');
        const storagePath = path.join(orgId, project.id, `${artifactId}${ext}`);
        finalPath = path.resolve(this.config.runner.artifactDir, storagePath);
        await rename(tmpPath, finalPath);
        const facts = await inspectArtifact(finalPath, metadata.kind);
        version = { filename, storagePath, ...facts };
      }

      let created: Awaited<ReturnType<PackageRepository['create']>>;
      try {
        created = await this.packages.create({
          id: randomUUID(),
          orgId,
          projectId: project.id,
          name: metadata.name,
          kind: metadata.kind,
        });
      } catch (err) {
        throw err instanceof PackageNameTakenError ? nameTaken(metadata.name) : err;
      }

      if (version !== null) {
        let added: Awaited<ReturnType<PackageRepository['addVersion']>>;
        try {
          added = await this.packages.addVersion(orgId, project.id, created.id, {
            artifactId,
            filename: version.filename,
            gatlingVersion: version.gatlingVersion,
            sha256: upload.sha256,
            bytes: upload.bytes,
            simulations: version.simulations,
            storagePath: version.storagePath,
          });
        } catch (err) {
          // The package was made a moment ago for this file and has nothing
          // else; leaving it would turn the caller's retry into a 409.
          await this.packages.delete(orgId, project.id, created.id).catch((deleteErr: unknown) => {
            console.warn(
              `could not remove package ${created.id} ("${metadata.name}") after storing its first version failed: ` +
                'an EMPTY package now exists, so a retry of the same name will answer 409 PACKAGE_NAME_TAKEN until it is deleted',
              deleteErr,
            );
          });
          throw err;
        }
        if (added === null) throw packageNotFound(created.id);
        // A new package holds no version yet, so nothing can be reused here; the
        // check is the same one an upload makes and costs nothing.
        if (added.reused && finalPath !== null) await unlink(finalPath).catch(() => undefined);
      }

      createdId = created.id;
      await unlink(tmpPath).catch(() => undefined);
    } catch (err) {
      await cleanup();
      throw err;
    }
    // OUTSIDE the try on purpose: past this point the version row exists and
    // names the file, so a failure to read the package back must never be
    // answered by removing that file.
    return this.respond(orgId, project.id, createdId);
  }

  @Put(':packageId/content')
  @Scopes('runner')
  async upload(
    @Param('slug') slug: string,
    @Param('packageId', uuidParam('packageId')) id: string,
    @Query('filename') filenameQuery: string | undefined,
    @Req() req: Request,
  ): Promise<Package> {
    const project = await this.resolveProject(req, slug);
    const orgId = req.tenant!.orgId;
    const pkg = await this.packages.find(orgId, project.id, id);
    if (!pkg) throw packageNotFound(id);

    // `?filename=a&filename=b` arrives as an array; only a single, non-blank
    // string names the file, and anything else is the same as no name.
    const named = typeof filenameQuery === 'string' && filenameQuery.trim() !== '';
    const filename = sanitizeFilename(
      named ? filenameQuery : `${pkg.name}${pkg.kind === 'gatling_jar' ? '.jar' : '.zip'}`,
    );
    // THE KIND IS CHECKED BEFORE THE BODY IS READ. A refused kind must not cost
    // the caller a 500 MB upload, and must not leave that upload on disk.
    const ext = extensionFor(filename, pkg.kind, 'package');

    const artifactId = randomUUID();
    const storagePath = path.join(orgId, project.id, `${artifactId}${ext}`);
    const finalPath = path.resolve(this.config.runner.artifactDir, storagePath);
    await mkdir(path.dirname(finalPath), { recursive: true });
    // readRawUpload removes its own partial file when it fails.
    const stored = await readRawUpload(req, finalPath, this.config.runner.maxArtifactBytes);

    try {
      const facts = await inspectArtifact(finalPath, pkg.kind);
      const added = await this.packages.addVersion(orgId, project.id, id, {
        artifactId,
        filename,
        gatlingVersion: facts.gatlingVersion,
        sha256: stored.sha256,
        bytes: stored.bytes,
        simulations: facts.simulations,
        storagePath,
      });
      if (added === null) throw packageNotFound(id);
      // The package already holds these exact bytes, so the earlier version was
      // made current and nothing new is stored: the file just written is the
      // duplicate, and it goes.
      if (added.reused) await unlink(finalPath).catch(() => undefined);
    } catch (err) {
      await unlink(finalPath).catch(() => undefined);
      throw err;
    }
    return this.respond(orgId, project.id, id);
  }

  @Patch(':packageId')
  @Scopes('runner')
  async rename(
    @Param('slug') slug: string,
    @Param('packageId', uuidParam('packageId')) id: string,
    @Req() req: Request,
  ): Promise<Package> {
    const project = await this.resolveProject(req, slug);
    const parsed = RenamePackageRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_PACKAGE_METADATA',
        `Invalid package name: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ')}`,
        'Send a JSON body with a "name" of 1 to 120 characters, for example {"name":"Checkout"}.',
      );
    }
    let renamed: Awaited<ReturnType<PackageRepository['rename']>>;
    try {
      renamed = await this.packages.rename(req.tenant!.orgId, project.id, id, parsed.data.name);
    } catch (err) {
      throw err instanceof PackageNameTakenError ? nameTaken(parsed.data.name) : err;
    }
    if (renamed === null) throw packageNotFound(id);
    return this.respond(req.tenant!.orgId, project.id, id);
  }

  @Delete(':packageId')
  @HttpCode(204)
  @UseGuards(SessionOnlyGuard)
  async remove(
    @Param('slug') slug: string,
    @Param('packageId', uuidParam('packageId')) id: string,
    @Req() req: Request,
  ): Promise<void> {
    const project = await this.resolveProject(req, slug);
    const result = await this.packages.delete(req.tenant!.orgId, project.id, id);
    if (result.kind === 'not_found') throw packageNotFound(id);
    if (result.kind === 'in_use') {
      const n = result.activeJobs;
      throw conflict(
        'PACKAGE_IN_USE',
        `${n} run${n === 1 ? '' : 's'} of this package ${n === 1 ? 'is' : 'are'} queued or running.`,
        'Wait for them to finish, or cancel them with POST /v1/projects/{slug}/runner/runs/{jobId}/cancel, then delete the package.',
      );
    }
    // The rows are gone; the files are not yet. A file that cannot be removed
    // is not worth failing a delete that has already committed: its version row
    // stays, unreferenced, and the runner's retention sweep deletes that row and
    // TRIES to remove the file. In the shipped compose file it cannot:
    // runner-artifacts is mounted read-only into the runner
    // (infra/docker-compose.yml), so its rm fails and is only logged
    // ("failed to remove retained runner file") — the row goes, the file stays.
    for (const storagePath of result.storagePaths) {
      await removeIfUnder(this.config.runner.artifactDir, storagePath);
    }
  }

  /**
   * 404 when the slug is not in the caller's org OR a bearer token minted for
   * one project names another project's slug. The same rule as
   * RunnerController.resolveProject, for the same reason: a token for project A
   * must not be able to read, create in or delete from project B.
   */
  private async resolveProject(req: Request, slug: string): Promise<ProjectRecord> {
    const tenant = req.tenant!;
    const project = await this.projects.findBySlugInOrg(tenant.orgId, slug);
    if (!project || (tenant.projectId !== undefined && tenant.projectId !== project.id)) {
      throw notFound(
        `No project "${slug}" in this organisation.`,
        'Check the slug, or list the projects this credential can reach with GET /v1/projects.',
      );
    }
    return project;
  }

  /** The package as it now stands, with its usage. */
  private async respond(orgId: string, projectId: string, id: string): Promise<Package> {
    const row = await this.packages.find(orgId, projectId, id);
    if (!row) throw packageNotFound(id);
    return toPackage(row);
  }
}

function nameTaken(name: string) {
  return conflict(
    'PACKAGE_NAME_TAKEN',
    `This project already has a package called "${name}".`,
    'Choose another name, or upload a new version to the existing package with PUT /v1/projects/{slug}/packages/{packageId}/content.',
  );
}

function notMultipart() {
  return badRequest(
    'INVALID_PACKAGE_METADATA',
    'A package is created with a multipart/form-data request, not a JSON body.',
    'POST multipart/form-data with a "metadata" part holding {"name":"Checkout","kind":"gatling_jar"} and, optionally, a file part named "artifact".',
  );
}

function parseCreateMetadata(raw: string): { name: string; kind: 'gatling_jar' | 'gatling_bundle' } {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw badRequest(
      'INVALID_PACKAGE_METADATA',
      'Package metadata must be valid JSON.',
      'Send a JSON "metadata" multipart field, for example {"name":"Checkout","kind":"gatling_jar"}.',
    );
  }
  const parsed = CreatePackageRequestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw badRequest(
      'INVALID_PACKAGE_METADATA',
      `Invalid package metadata: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'metadata'} ${i.message}`).join('; ')}`,
      'Send metadata with a "name" of 1 to 120 characters and a "kind" of gatling_jar or gatling_bundle. See /v1/openapi.json for the full schema.',
    );
  }
  return parsed.data;
}

/**
 * Removes a version's file, refusing anything that does not resolve to a path
 * STRICTLY inside the artifact directory. A stored path is data a past version
 * of this code wrote; a delete that followed one out of the directory — or onto
 * the directory itself — would be a far worse failure than a file left behind.
 */
async function removeIfUnder(root: string, storedPath: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const target = path.isAbsolute(storedPath) ? path.resolve(storedPath) : path.resolve(resolvedRoot, storedPath);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) {
    console.warn(`skipping package file delete outside ${resolvedRoot}: ${target}`);
    return;
  }
  await rm(target, { force: true }).catch((err: unknown) => {
    console.warn(`failed to remove package file ${target}`, err);
  });
}

/** The contract is the arbiter of the shape: a row that does not fit it (a kind
 *  outside the enum, say) fails HERE rather than reaching a client. */
function toPackage(record: PackageWithUsage): Package {
  return PackageSchema.parse({
    id: record.id,
    name: record.name,
    kind: record.kind,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    current:
      record.current === null
        ? null
        : {
            artifactId: record.current.artifactId,
            filename: record.current.filename,
            bytes: record.current.bytes,
            sha256: record.current.sha256,
            gatlingVersion: record.current.gatlingVersion,
            simulations: record.current.simulations,
            uploadedAt: record.current.uploadedAt.toISOString(),
          },
    usage: record.usage,
  });
}
