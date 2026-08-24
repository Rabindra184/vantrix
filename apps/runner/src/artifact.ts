import { execFile } from 'node:child_process';
import { access, chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GatlingJarFacts } from '@perfportal/core';
import type { RunnerArtifactRecord, RunnerJobRecord } from '@perfportal/persistence';
import { readGatlingJar } from '@perfportal/storage';
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
  workDir: string;
}

export async function prepareGatlingRun(
  config: RunnerConfig,
  job: RunnerJobRecord,
  artifact: RunnerArtifactRecord,
  shouldStop: () => Promise<boolean>,
): Promise<PreparedGatlingRun> {
  const artifactPath = resolveArtifactPath(config, artifact.storagePath);
  await access(artifactPath).catch(() => {
    throw new RunnerExecutionError(
      'ARTIFACT_NOT_FOUND',
      `Artifact file is not readable at ${artifactPath}.`,
      'Make sure the API and runner share RUNNER_ARTIFACT_DIR on the same on-prem node or volume.',
    );
  });

  const workDir = path.resolve(config.workDir, job.id);
  const resultsDir = path.join(workDir, 'results');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(resultsDir, { recursive: true });

  if (artifact.kind === 'gatling_jar') {
    await makeChildWritable(workDir);
    return {
      resultsDir,
      workDir,
      command: {
        command: config.javaBin,
        cwd: workDir,
        args: [
          ...jvmArgs(job),
          '-cp',
          await jarClasspath(config, artifactPath),
          'io.gatling.app.Gatling',
          '-s',
          artifact.simulationClass,
          '-rf',
          resultsDir,
        ],
        env: runnerChildEnv(config),
        uid: config.childUid ?? undefined,
        gid: config.childGid ?? undefined,
      },
    };
  }

  if (artifact.kind === 'gatling_bundle') {
    const bundleDir = path.join(workDir, 'bundle');
    await mkdir(bundleDir, { recursive: true });
    await extractBundle(artifactPath, bundleDir, workDir, shouldStop);
    await assertSafeExtractedTree(bundleDir, Date.now() + EXTRACT_TIMEOUT_MS);
    await makeChildWritable(workDir);
    const gatlingHome = await findGatlingHome(bundleDir);
    const javaArgs = jvmArgs(job);
    return {
      resultsDir,
      workDir,
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
        uid: config.childUid ?? undefined,
        gid: config.childGid ?? undefined,
      },
    };
  }

  throw new RunnerExecutionError(
    'UNSUPPORTED_ARTIFACT_KIND',
    `Unsupported runner artifact kind "${artifact.kind}".`,
    'Upload a Gatling fat jar or a Gatling bundle archive.',
  );
}

/**
 * The JVM options every Gatling launch here gets, before the operator's own.
 *
 * ═══ WITHOUT THESE, NOTHING RUNS ON JAVA 17 OR LATER ═══
 *
 * Gatling 3.15's log writer reaches into `java.lang` through
 * `MethodHandles.privateLookupIn`, which the module system refuses unless the
 * package is opened. The failure is total and arrives before the first byte of
 * `simulation.log`:
 *
 *     java.lang.IllegalAccessException: module java.base does not open
 *     java.lang to unnamed module
 *       at io.gatling.core.stats.writer.StringInternals.<clinit>
 *
 * The runner then reports SIMULATION_LOG_NOT_FOUND, whose remediation points
 * at the simulation class — so the operator is sent to check the one thing
 * that was fine. `infra/Dockerfile` shipped exactly 17, and 17 is already
 * affected, so this was EVERY containerized job rather than an edge case.
 *
 * Gatling's own `gatling.sh` and the `io.gatling.gradle` plugin both pass
 * these; running the launcher directly, as this does, is what lost them.
 * MEASURED: `java.base/java.lang` ALONE is sufficient for 3.15.1 — the rest
 * mirror Gatling's own launcher so that a feature needing one of them does not
 * fail here while working under `gatling.sh`.
 *
 * OPERATOR OPTIONS COME AFTER, so `javaOptions` can still override anything
 * here; `--add-opens` accumulates rather than replacing, so adding more is
 * always safe.
 */
const DEFAULT_JVM_OPTIONS = [
  '--add-opens=java.base/java.lang=ALL-UNNAMED',
  '--add-opens=java.base/java.lang.reflect=ALL-UNNAMED',
  '--add-opens=java.base/java.util=ALL-UNNAMED',
  '--add-opens=java.base/java.util.concurrent=ALL-UNNAMED',
  '--add-opens=java.base/sun.nio.ch=ALL-UNNAMED',
];

function jvmArgs(job: RunnerJobRecord): string[] {
  return [
    ...DEFAULT_JVM_OPTIONS,
    ...splitArgs(job.javaOptions),
    ...systemPropertyArgs(job.systemProperties),
  ];
}

/**
 * The classpath for an uploaded jar — the jar itself, plus a Gatling runtime
 * lent to it when it carries none.
 *
 * ═══ THE THIN JAR IS THE NORMAL CASE, NOT THE EXCEPTION ═══
 *
 * `./gradlew gatlingEnterprisePackage` is the command Gatling documents, and
 * it deliberately packages simulations WITHOUT the framework, because Gatling
 * Enterprise supplies that at execution time. Running such a jar alone fails
 * before Gatling starts:
 *
 *     Error: Could not find or load main class io.gatling.app.Gatling
 *
 * So this is the runner being the thing Enterprise is: whoever runs the test
 * provides the runtime. A jar that DOES carry the framework — a shadow/fat jar
 * — is launched exactly as before, alone on the classpath, so nothing that
 * worked stops working.
 *
 * THE UPLOADED JAR COMES FIRST. Classpath order decides duplicates, so a jar
 * carrying its own copy of anything keeps it; the lent runtime can only supply
 * what the jar lacks.
 */
async function jarClasspath(config: RunnerConfig, artifactPath: string): Promise<string> {
  let facts: GatlingJarFacts;
  try {
    facts = await readGatlingJar(artifactPath);
  } catch (err) {
    throw new RunnerExecutionError(
      'ARTIFACT_NOT_A_JAR',
      `The uploaded artifact could not be read as a jar: ${String(err)}`,
      'Upload a .jar built by `gradlew gatlingEnterprisePackage` (or an equivalent Maven/sbt packager), or choose the runnable-bundle artifact type.',
    );
  }

  if (facts.carriesRuntime) return artifactPath;

  const lib = await resolveGatlingLib(config.gatlingHome);
  if (lib === null) {
    throw new RunnerExecutionError(
      'GATLING_RUNTIME_REQUIRED',
      'This jar contains simulations but not the Gatling framework, and this runner has no Gatling distribution to lend it.',
      'Set RUNNER_GATLING_HOME on the runner to an unpacked Gatling distribution, or upload a fat jar that bundles Gatling itself.',
    );
  }

  // A runtime one framework version away from the jar produces NoSuchMethodError
  // deep inside a run, minutes later, with nothing naming the cause. Refusing
  // up front costs an operator one clear message instead.
  const runtimeVersion = await gatlingRuntimeVersion(lib);
  if (
    facts.gatlingVersion !== null &&
    runtimeVersion !== null &&
    facts.gatlingVersion !== runtimeVersion
  ) {
    throw new RunnerExecutionError(
      'GATLING_VERSION_MISMATCH',
      `The jar was packaged against Gatling ${facts.gatlingVersion} but this runner lends Gatling ${runtimeVersion}.`,
      `Point RUNNER_GATLING_HOME at a Gatling ${facts.gatlingVersion} distribution, or repackage the simulations against ${runtimeVersion}.`,
    );
  }

  // `lib/*` is expanded by the JVM itself, and it expands to JARs only — a
  // classes directory placed there would be silently invisible.
  return [artifactPath, path.join(lib, '*')].join(path.delimiter);
}

/**
 * The directory of jars inside a configured Gatling home.
 *
 * Accepts either shape an operator is likely to have: an unpacked distribution
 * (which has `lib/` beside `bin/`) or a bare directory of jars. Returns null
 * when nothing is configured or the path does not exist, which the caller
 * turns into an actionable error rather than a stack trace.
 */
async function resolveGatlingLib(home: string | null): Promise<string | null> {
  if (home === null) return null;
  const root = path.resolve(home);
  const candidates = [path.join(root, 'lib'), root];
  for (const candidate of candidates) {
    try {
      const entries = await readdir(candidate);
      if (entries.some((entry) => entry.endsWith('.jar'))) return candidate;
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

/**
 * Which Gatling the lent runtime is, read from `gatling-core-<version>.jar`.
 *
 * `gatling-core` rather than `gatling-app`, because it is the artifact whose
 * version IS the framework version in every distribution layout. Null when no
 * such jar is present, in which case the version check above declines to
 * guess.
 */
async function gatlingRuntimeVersion(lib: string): Promise<string | null> {
  const entries = await readdir(lib).catch(() => [] as string[]);
  for (const entry of entries) {
    const match = /^gatling-core-(\d+\.\d+\.\d+.*)\.jar$/.exec(entry);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

function resolveArtifactPath(config: RunnerConfig, storagePath: string): string {
  return path.isAbsolute(storagePath)
    ? storagePath
    : path.resolve(config.artifactDir, storagePath);
}

async function makeChildWritable(root: string): Promise<void> {
  await chmod(root, 0o777).catch(() => undefined);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    await chmod(full, entry.isDirectory() ? 0o777 : 0o666).catch(() => undefined);
    if (entry.isDirectory()) await makeChildWritable(full);
  }
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
