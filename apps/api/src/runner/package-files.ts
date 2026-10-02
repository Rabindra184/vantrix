import path from 'node:path';
import { ingestError, type GatlingJarFacts } from '@perfportal/core';
import { readGatlingJar } from '@perfportal/storage';
import { badRequest, notFound } from '../common/validation.js';

export function sanitizeFilename(filename: string): string {
  return path.basename(filename).replace(/[^\w.\- ]/g, '_') || 'gatling-artifact';
}

/**
 * The package a file belongs to when the request names none: the filename
 * without its extension (`.tar.gz` counted as one), at most 112 characters —
 * EXACTLY the migration's backfill expression, so an upload after the
 * migration lands in the package the backfill made for its predecessors.
 */
export function packageNameFromFilename(filename: string): string {
  const stem = filename.replace(/(\.tar\.gz|\.[^.]+)$/i, '').slice(0, 112).trim();
  return stem === '' ? 'package' : stem;
}

/**
 * The stored extension for a file of `kind`, or PACKAGE_KIND_MISMATCH when the
 * file's own extension does not suit it.
 *
 * `decidedBy` says WHAT chose the kind, because the refusal has to name it:
 * `'package'` when an existing package's kind is fixed (the package create and
 * PUT), `'request'` when the upload-and-start's own "artifactKind" chose it —
 * defaulting to gatling_jar, so the likeliest caller there sent a .zip and
 * forgot the field, and may have named no package at all. REQUIRED, with no
 * default: a forgetting caller defaulted to `'package'` would tell that person
 * about a package they never mentioned, and point them at a lever that does
 * not change what the start reads.
 */
export function extensionFor(filename: string, kind: string, decidedBy: 'package' | 'request'): string {
  const lower = filename.toLowerCase();
  const ext = lower.endsWith('.tar.gz') ? '.tar.gz' : path.extname(lower);
  const jar = kind === 'gatling_jar';
  const allowed = jar ? new Set(['.jar']) : new Set(['.zip', '.tgz', '.tar.gz']);
  if (ext === '') return jar ? '.jar' : '.zip';
  if (allowed.has(ext)) return ext;
  const what = jar ? 'Gatling jar' : 'runnable bundle';
  if (decidedBy === 'request') {
    throw badRequest(
      'PACKAGE_KIND_MISMATCH',
      `"${filename}" is not a ${what}, which is what "artifactKind" says this upload is.`,
      jar
        ? 'Upload a .jar, or set "artifactKind" to "gatling_bundle" in the metadata to upload an archive.'
        : 'Upload a .zip, .tgz or .tar.gz, or set "artifactKind" to "gatling_jar" in the metadata to upload a jar.',
    );
  }
  throw badRequest(
    'PACKAGE_KIND_MISMATCH',
    `"${filename}" is not a ${what}, which is what this package holds.`,
    jar
      ? 'Upload a .jar to this package, or create a runnable-bundle package for the archive.'
      : 'Upload a .zip, .tgz or .tar.gz to this package, or create a Gatling-jar package for the jar.',
  );
}

/**
 * The one refusal for a file with no bytes, from each of the three writers that
 * store a package version: a package create's "artifact" part, a package PUT's
 * raw body, and an upload-and-start's "artifact" part. One definition, so none
 * of them can quietly stop refusing: an empty bundle is never inspected, so
 * without this it becomes a package's current version and a later start dies on
 * the runner, minutes later, instead of here.
 *
 * `writer` picks the remediation, which has to name the lever THAT request has
 * (an omitted part creates an empty package only on a create; a PUT has no part
 * at all). Required, for the reason `extensionFor`'s `decidedBy` is.
 */
export function emptyFile(writer: 'package-create' | 'package-upload' | 'runner-start') {
  return ingestError('BUNDLE_EMPTY', {
    message: 'The uploaded file was empty.',
    remediation: EMPTY_FILE_REMEDIATION[writer],
  });
}

const EMPTY_FILE_REMEDIATION = {
  'package-create':
    'Attach a non-empty Gatling jar or runnable bundle as the "artifact" part, or omit it to create the package with no version.',
  'package-upload': 'Send the package file as the raw request body.',
  'runner-start': 'Attach a non-empty Gatling jar or runnable bundle as the "artifact" part.',
} as const;

/**
 * Reads what a version can tell us about itself. A jar must open as a zip; an
 * empty Gatling-Simulations list means "nobody wrote the header", stored as
 * null (unknown), never as []. A bundle is not examined.
 */
export async function inspectArtifact(
  filePath: string,
  kind: string,
): Promise<{ gatlingVersion: string | null; simulations: string[] | null }> {
  if (kind !== 'gatling_jar') return { gatlingVersion: null, simulations: null };
  let facts: GatlingJarFacts;
  try {
    facts = await readGatlingJar(filePath);
  } catch (err) {
    throw badRequest(
      'RUNNER_ARTIFACT_NOT_A_JAR',
      `The uploaded file could not be read as a jar: ${err instanceof Error ? err.message : String(err)}`,
      'Upload a .jar built by `gradlew gatlingEnterprisePackage` (or an equivalent Maven/sbt packager), or choose the runnable bundle artifact type.',
    );
  }
  return {
    gatlingVersion: facts.gatlingVersion,
    simulations: facts.simulations.length === 0 ? null : [...facts.simulations],
  };
}

/**
 * Silence is "cannot check", never "wrong": a null list means nobody wrote the
 * manifest header, and a hand-rolled shadow jar that carries none must still be
 * accepted for any class it holds.
 */
export function assertSimulationListed(simulations: readonly string[] | null, simulationClass: string): void {
  if (simulations === null || simulations.includes(simulationClass)) return;
  throw badRequest(
    'SIMULATION_CLASS_NOT_IN_ARTIFACT',
    `This jar declares no simulation called "${simulationClass}".`,
    `Use one of the simulations it does declare: ${simulations.join(', ')}.`,
  );
}

/** One 404 for a package this project does not have (a wrong id, another
 *  project's, or one deleted) — shared by the package routes and the runner's
 *  start, so the two cannot drift into describing one absence two ways. */
export function packageNotFound(id: string) {
  return notFound(`No package ${id} in this project.`, 'List this project’s packages with GET /v1/projects/{slug}/packages.');
}
