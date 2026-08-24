import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunnerArtifactRecord, RunnerJobRecord } from '@perfportal/persistence';
import { prepareGatlingRun } from '../src/artifact.js';
import type { RunnerConfig } from '../src/config.js';
import { RunnerExecutionError } from '../src/errors.js';
import { GATLING_MAIN_CLASS, gatlingManifest, writeJar } from '../../../packages/storage/test/support/jar.js';

/**
 * How the runner builds the `java` command for an uploaded jar.
 *
 * ═══ THE TWO DEFECTS THIS FILE EXISTS FOR ═══
 *
 * BOTH made every on-prem job fail, and neither was visible to any suite.
 *
 * FIRST, the command carried no `--add-opens`. Gatling 3.15 reaches into
 * `java.lang` through `MethodHandles.privateLookupIn`, which the module system
 * refuses on Java 17+, so the JVM died at `StringInternals.<clinit>` before
 * writing a byte of `simulation.log` — and `infra/Dockerfile` ships a JRE well
 * past 17. Gatling's own `gatling.sh` passes these; launching
 * `io.gatling.app.Gatling` directly is what lost them.
 *
 * SECOND, the classpath was the uploaded jar and nothing else. That only works
 * for a fat jar, and `gatlingEnterprisePackage` — the command Gatling's docs
 * give you — deliberately builds a THIN one, because Gatling Enterprise
 * supplies the framework at execution time. The natural artifact therefore
 * failed with `Could not find or load main class io.gatling.app.Gatling`.
 *
 * Asserting on the ARGUMENT VECTOR is the point: every one of these failures
 * is a command that spawns happily and dies in the JVM, so nothing short of
 * reading the args it built can catch them before a real run does.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'runner-artifact-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A Gatling distribution to lend: only filenames are ever read. */
async function fakeRuntime(shape: 'distribution' | 'bare-lib', version = '3.15.1'): Promise<string> {
  const home = path.join(root, `gatling-${shape}`);
  const lib = shape === 'distribution' ? path.join(home, 'lib') : home;
  await mkdir(lib, { recursive: true });
  await writeFile(path.join(lib, `gatling-core-${version}.jar`), '');
  await writeFile(path.join(lib, `gatling-app-${version}.jar`), '');
  return home;
}

async function thinJar(name = 'thin.jar', version: string | null = '3.15.1'): Promise<string> {
  const file = path.join(root, name);
  await writeJar(file, [
    {
      name: 'META-INF/MANIFEST.MF',
      content: gatlingManifest(
        version === null
          ? { 'Gatling-Simulations': 'example.ParitySimulation' }
          : { 'Gatling-Version': version, 'Gatling-Simulations': 'example.ParitySimulation' },
      ),
    },
    { name: 'example/ParitySimulation.class', content: 'x' },
  ]);
  return file;
}

async function fatJar(name = 'fat.jar'): Promise<string> {
  const file = path.join(root, name);
  await writeJar(file, [
    { name: GATLING_MAIN_CLASS, content: 'x' },
    { name: 'example/ParitySimulation.class', content: 'x' },
  ]);
  return file;
}

function config(over: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    javaBin: 'java',
    artifactDir: root,
    workDir: path.join(root, 'work'),
    gatlingHome: null,
    childUid: null,
    childGid: null,
    ...over,
  } as RunnerConfig;
}

function job(over: Partial<RunnerJobRecord> = {}): RunnerJobRecord {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    javaOptions: null,
    systemProperties: {},
    ...over,
  } as unknown as RunnerJobRecord;
}

function artifact(storagePath: string): RunnerArtifactRecord {
  return {
    kind: 'gatling_jar',
    storagePath,
    simulationClass: 'example.ParitySimulation',
  } as unknown as RunnerArtifactRecord;
}

const prepare = (cfg: RunnerConfig, jarPath: string, over: Partial<RunnerJobRecord> = {}) =>
  prepareGatlingRun(cfg, job(over), artifact(jarPath), async () => false);

/** The `-cp` value, which is the argument AFTER the `-cp` flag. */
function classpathOf(args: readonly string[]): string {
  const at = args.indexOf('-cp');
  expect(at).toBeGreaterThanOrEqual(0);
  return args[at + 1] ?? '';
}

describe('prepareGatlingRun, jar artifacts', () => {
  it('lends a Gatling runtime to a jar that carries none', async () => {
    const home = await fakeRuntime('distribution');
    const jar = await thinJar();

    const prepared = await prepare(config({ gatlingHome: home }), jar);

    const classpath = classpathOf(prepared.command.args);
    expect(classpath.split(path.delimiter)).toEqual([jar, path.join(home, 'lib', '*')]);
    // The uploaded jar comes FIRST: classpath order decides duplicates, so a
    // jar carrying its own copy of anything keeps it and the lent runtime can
    // only supply what is missing.
    expect(classpath.indexOf(jar)).toBe(0);
  });

  it('leaves a fat jar alone on the classpath', async () => {
    const home = await fakeRuntime('distribution');
    const jar = await fatJar();

    const prepared = await prepare(config({ gatlingHome: home }), jar);

    // Not merely "contains the jar" — mixing a second Gatling into a jar that
    // already has one is how a version skew becomes a NoSuchMethodError deep
    // in a run, so the runtime must be absent entirely.
    expect(classpathOf(prepared.command.args)).toBe(jar);
  });

  it('refuses a thin jar with an actionable error when it has no runtime to lend', async () => {
    const jar = await thinJar();

    await expect(prepare(config({ gatlingHome: null }), jar)).rejects.toMatchObject({
      code: 'GATLING_RUNTIME_REQUIRED',
    });
    // The remediation has to name both ways out, because which one applies
    // depends on whether the reader controls the runner or the build.
    const error = await prepare(config({ gatlingHome: null }), jar).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(RunnerExecutionError);
    const remediation = (error as RunnerExecutionError).remediation;
    expect(remediation).toContain('RUNNER_GATLING_HOME');
    expect(remediation).toContain('fat jar');
  });

  it('refuses to lend a runtime a framework version away from the jar', async () => {
    // Silently proceeding produces a NoSuchMethodError minutes into a run,
    // with nothing naming the cause.
    const home = await fakeRuntime('distribution', '3.13.5');
    const jar = await thinJar('mismatched.jar', '3.15.1');

    await expect(prepare(config({ gatlingHome: home }), jar)).rejects.toMatchObject({
      code: 'GATLING_VERSION_MISMATCH',
    });
  });

  it('lends without complaint when the jar names no version to check against', async () => {
    // A hand-rolled thin jar declares no `Gatling-Version`. Absent is "cannot
    // check", never "mismatched" — refusing here would reject a jar that runs.
    const home = await fakeRuntime('distribution', '3.13.5');
    const jar = await thinJar('unversioned.jar', null);

    const prepared = await prepare(config({ gatlingHome: home }), jar);
    expect(classpathOf(prepared.command.args)).toContain(path.join(home, 'lib', '*'));
  });

  it('accepts a bare directory of jars as the runtime, not just a distribution', async () => {
    const home = await fakeRuntime('bare-lib');
    const jar = await thinJar();

    const prepared = await prepare(config({ gatlingHome: home }), jar);
    expect(classpathOf(prepared.command.args)).toContain(path.join(home, '*'));
  });

  it('always opens java.lang, with or without operator options', async () => {
    const home = await fakeRuntime('distribution');
    const jar = await thinJar();

    const bare = await prepare(config({ gatlingHome: home }), jar);
    expect(bare.command.args).toContain('--add-opens=java.base/java.lang=ALL-UNNAMED');

    const withOptions = await prepare(config({ gatlingHome: home }), jar, {
      javaOptions: '-Xmx2g',
    } as Partial<RunnerJobRecord>);
    const args = withOptions.command.args;
    expect(args).toContain('--add-opens=java.base/java.lang=ALL-UNNAMED');
    // Operator options come AFTER the defaults so they can still override
    // them; a default appended last would silently win over the operator.
    expect(args.indexOf('-Xmx2g')).toBeGreaterThan(
      args.indexOf('--add-opens=java.base/java.lang=ALL-UNNAMED'),
    );
  });

  it('refuses an artifact that is not a jar at all', async () => {
    const file = path.join(root, 'renamed.jar');
    await writeFile(file, 'a text file somebody renamed');

    await expect(prepare(config({ gatlingHome: await fakeRuntime('distribution') }), file))
      .rejects.toMatchObject({ code: 'ARTIFACT_NOT_A_JAR' });
  });
});
