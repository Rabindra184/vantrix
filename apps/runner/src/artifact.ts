import { execFile } from 'node:child_process';
import { access, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RunnerArtifactRecord, RunnerJobRecord } from '@perfportal/persistence';
import type { RunnerConfig } from './config.js';
import { RunnerExecutionError } from './errors.js';
import type { ProcessCommand } from './process.js';
import { spawnAndWait } from './process.js';
import { splitArgs, systemPropertyArgs } from './args.js';

const execFileAsync = promisify(execFile);
const EXTRACT_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_EXTRACTED_BUNDLE_BYTES = 1024 * 1024 * 1024;

export interface PreparedGatlingRun {
  command: ProcessCommand;
  resultsDir: string;
}

export async function prepareGatlingRun(
  config: RunnerConfig,
  job: RunnerJobRecord,
  artifact: RunnerArtifactRecord,
  shouldStop: () => Promise<boolean>,
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
        env: runnerChildEnv(config),
      },
    };
  }

  if (artifact.kind === 'gatling_bundle') {
    const bundleDir = path.join(workDir, 'bundle');
    await mkdir(bundleDir, { recursive: true });
    await extractBundle(artifact.storagePath, bundleDir, workDir, shouldStop);
    await assertSafeExtractedTree(bundleDir, Date.now() + EXTRACT_TIMEOUT_MS);
    const gatlingHome = await findGatlingHome(bundleDir);
    const javaArgs = [
      ...splitArgs(job.javaOptions),
      ...systemPropertyArgs(job.systemProperties),
    ];
    return {
      resultsDir,
      command: {
        command: config.javaBin,
        cwd: gatlingHome,
        args: [
          ...javaArgs,
          '-cp',
          path.join(gatlingHome, 'lib', '*'),
          'io.gatling.app.Gatling',
          '-s',
          artifact.simulationClass,
          '-rf',
          resultsDir,
        ],
        env: runnerChildEnv(config),
      },
    };
  }

  throw new RunnerExecutionError(
    'UNSUPPORTED_ARTIFACT_KIND',
    `Unsupported runner artifact kind "${artifact.kind}".`,
    'Upload a Gatling fat jar or a Gatling bundle archive.',
  );
}

async function extractBundle(
  artifactPath: string,
  bundleDir: string,
  workDir: string,
  shouldStop: () => Promise<boolean>,
): Promise<void> {
  const lower = artifactPath.toLowerCase();
  await assertArchiveHasNoLinks(artifactPath, lower);
  const command = lower.endsWith('.zip')
    ? { command: 'unzip', args: ['-q', artifactPath, '-d', bundleDir], cwd: workDir }
    : lower.endsWith('.tgz') || lower.endsWith('.tar.gz')
      ? {
          command: 'tar',
          args: ['--no-same-owner', '--no-same-permissions', '-xzf', artifactPath, '-C', bundleDir],
          cwd: workDir,
        }
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
    timeoutMs: EXTRACT_TIMEOUT_MS,
    shouldStop,
  });
  if (result.code !== 0) {
    throw new RunnerExecutionError(
      'BUNDLE_EXTRACT_FAILED',
      `Bundle extraction exited with code ${result.code ?? `signal ${result.signal}`}.`,
      'Confirm the uploaded bundle archive is valid and contains a Gatling distribution.',
    );
  }
}

async function assertArchiveHasNoLinks(artifactPath: string, lowerPath: string): Promise<void> {
  const listing =
    lowerPath.endsWith('.zip')
      ? await execFileAsync('zipinfo', ['-l', artifactPath], { maxBuffer: 8 * 1024 * 1024 })
      : lowerPath.endsWith('.tgz') || lowerPath.endsWith('.tar.gz')
        ? await execFileAsync('tar', ['-tzvf', artifactPath], { maxBuffer: 8 * 1024 * 1024 })
        : null;
  if (listing === null) return;
  const link = listing.stdout.split(/\r?\n/).find((line) => /^[lh]/.test(line));
  if (link !== undefined) {
    throw new RunnerExecutionError(
      'UNSAFE_BUNDLE_ENTRY',
      'Runnable Gatling bundles cannot contain symbolic links or hard links.',
      'Repackage the bundle with regular files only, then queue a new run.',
    );
  }
}

async function assertSafeExtractedTree(root: string, deadlineMs: number): Promise<void> {
  let totalBytes = 0;
  async function visit(dir: string): Promise<void> {
    if (Date.now() > deadlineMs) {
      throw new RunnerExecutionError(
        'BUNDLE_EXTRACT_TIMEOUT',
        'Bundle validation exceeded the extraction time limit.',
        'Upload a smaller runnable bundle or use the Gatling jar artifact type.',
      );
    }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) {
        throw new RunnerExecutionError(
          'UNSAFE_BUNDLE_ENTRY',
          'Runnable Gatling bundles cannot contain symbolic links or hard links.',
          'Repackage the bundle with regular files only, then queue a new run.',
        );
      }
      if (info.isFile()) {
        totalBytes += info.size;
        if (totalBytes > MAX_EXTRACTED_BUNDLE_BYTES) {
          throw new RunnerExecutionError(
            'BUNDLE_TOO_LARGE_AFTER_EXTRACT',
            `Bundle extraction exceeded the ${MAX_EXTRACTED_BUNDLE_BYTES}-byte uncompressed limit.`,
            'Upload a smaller runnable bundle or use the Gatling jar artifact type.',
          );
        }
      }
      if (info.isDirectory()) await visit(full);
    }
  }
  await visit(root);
}

async function findGatlingHome(root: string): Promise<string> {
  const direct = [
    path.join(root, 'bin', 'gatling.sh'),
    path.join(root, 'gatling', 'bin', 'gatling.sh'),
  ];
  for (const candidate of direct) {
    try {
      await access(candidate);
      return path.dirname(path.dirname(candidate));
    } catch {
      // Try the recursive search below.
    }
  }

  const found = await findFile(root, 'gatling.sh', 4);
  if (found) return path.dirname(path.dirname(found));
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

function runnerChildEnv(config: RunnerConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: path.resolve(config.workDir),
    TMPDIR: path.resolve(config.workDir),
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
  };
  if (process.env.JAVA_HOME) env.JAVA_HOME = process.env.JAVA_HOME;
  return env;
}
