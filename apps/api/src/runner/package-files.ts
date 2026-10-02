import path from 'node:path';
import type { GatlingJarFacts } from '@perfportal/core';
import { readGatlingJar } from '@perfportal/storage';
import { badRequest } from '../common/validation.js';

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

export function extensionFor(filename: string, kind: string): string {
  const lower = filename.toLowerCase();
  const ext = lower.endsWith('.tar.gz') ? '.tar.gz' : path.extname(lower);
  const allowed = kind === 'gatling_jar' ? new Set(['.jar']) : new Set(['.zip', '.tgz', '.tar.gz']);
  if (ext === '') return kind === 'gatling_jar' ? '.jar' : '.zip';
  if (allowed.has(ext)) return ext;
  throw badRequest(
    'PACKAGE_KIND_MISMATCH',
    `"${filename}" is not a ${kind === 'gatling_jar' ? 'Gatling jar' : 'runnable bundle'}, which is what this package holds.`,
    kind === 'gatling_jar'
      ? 'Upload a .jar to this package, or create a runnable-bundle package for the archive.'
      : 'Upload a .zip, .tgz or .tar.gz to this package, or create a Gatling-jar package for the jar.',
  );
}

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
