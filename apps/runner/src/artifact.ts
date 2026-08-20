import { access, chmod, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { RunnerArtifactRecord, RunnerJobRecord } from '@perfportal/persistence';
import type { RunnerConfig } from './config.js';
import { RunnerExecutionError } from './errors.js';
import type { ProcessCommand } from './process.js';
import { spawnAndWait } from './process.js';
import { splitArgs, systemPropertyArgs } from './args.js';

export interface PreparedGatlingRun {
  command: ProcessCommand;
  resultsDir: string;
}

export async function prepareGatlingRun(
  config: RunnerConfig,
  job: RunnerJobRecord,
  artifact: RunnerArtifactRecord,
): Promise<PreparedGatlingRun> {
  await access(artifact.storagePath).catch(() => {
    throw new RunnerExecutionError(
      'ARTIFACT_NOT_FOUND',
      `Artifact file is not readable at ${artifact.storagePath}.`,
      'Make sure the API and runner share RUNNER_ARTIFACT_DIR on the same on-prem node or volume.',
    );
  });

  const workDir = path.resolve(config.workDir, job.id);
  const resultsDir = path.join(workDir, 'results');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(resultsDir, { recursive: true });

  if (artifact.kind === 'gatling_jar') {
    return {
      resultsDir,
      command: {
        command: config.javaBin,
        cwd: workDir,
        args: [
          ...splitArgs(job.javaOptions),
          ...systemPropertyArgs(job.systemProperties),
          '-cp',
          artifact.storagePath,
          'io.gatling.app.Gatling',
          '-s',
          artifact.simulationClass,
          '-rf',
          resultsDir,
        ],
      },
    };
  }

  if (artifact.kind === 'gatling_bundle') {
    const bundleDir = path.join(workDir, 'bundle');
    await mkdir(bundleDir, { recursive: true });
    await extractBundle(artifact.storagePath, bundleDir, workDir);
    const script = await findGatlingScript(bundleDir);
    await chmod(script, 0o755).catch(() => undefined);
    const javaOpts = [
      ...splitArgs(job.javaOptions),
      ...systemPropertyArgs(job.systemProperties),
    ].join(' ');
    return {
      resultsDir,
      command: {
        command: script,
        cwd: path.dirname(script),
        args: ['-s', artifact.simulationClass, '-rf', resultsDir],
        env: { ...process.env, JAVA_OPTS: javaOpts },
      },
    };
  }

  throw new RunnerExecutionError(
    'UNSUPPORTED_ARTIFACT_KIND',
    `Unsupported runner artifact kind "${artifact.kind}".`,
    'Upload a Gatling fat jar or a Gatling bundle archive.',
  );
}

async function extractBundle(artifactPath: string, bundleDir: string, workDir: string): Promise<void> {
  const lower = artifactPath.toLowerCase();
  const command = lower.endsWith('.zip')
    ? { command: 'unzip', args: ['-q', artifactPath, '-d', bundleDir], cwd: workDir }
    : lower.endsWith('.tgz') || lower.endsWith('.tar.gz')
      ? { command: 'tar', args: ['-xzf', artifactPath, '-C', bundleDir], cwd: workDir }
      : null;

  if (!command) {
    throw new RunnerExecutionError(
      'UNSUPPORTED_BUNDLE_FORMAT',
      'Runnable Gatling bundles must be .zip, .tgz, or .tar.gz archives.',
      'Upload a supported bundle archive, or choose the Gatling jar artifact type.',
    );
  }

  const result = await spawnAndWait(command, {
    stdoutPrefix: '[runner extract] ',
    stderrPrefix: '[runner extract] ',
  });
  if (result.code !== 0) {
    throw new RunnerExecutionError(
      'BUNDLE_EXTRACT_FAILED',
      `Bundle extraction exited with code ${result.code ?? `signal ${result.signal}`}.`,
      'Confirm the uploaded bundle archive is valid and contains a Gatling distribution.',
    );
  }
}

async function findGatlingScript(root: string): Promise<string> {
  const direct = [
    path.join(root, 'bin', 'gatling.sh'),
    path.join(root, 'gatling', 'bin', 'gatling.sh'),
  ];
  for (const candidate of direct) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the recursive search below.
    }
  }

  const found = await findFile(root, 'gatling.sh', 4);
  if (found) return found;
  throw new RunnerExecutionError(
    'GATLING_SCRIPT_NOT_FOUND',
    'The bundle did not contain a bin/gatling.sh script.',
    'Upload a runnable Gatling bundle, or upload a fat jar and use the Gatling jar artifact type.',
  );
}

async function findFile(dir: string, basename: string, depth: number): Promise<string | null> {
  if (depth < 0) return null;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === basename) return full;
    if (entry.isDirectory()) {
      const found = await findFile(full, basename, depth - 1);
      if (found) return found;
    }
  }
  return null;
}
