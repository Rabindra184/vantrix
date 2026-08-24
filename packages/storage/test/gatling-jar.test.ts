import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatlingJarReadError } from '@perfportal/core';
import { readGatlingJar } from '../src/gatling-jar.js';
import { GATLING_MAIN_CLASS, gatlingManifest, writeJar } from './support/jar.js';

/**
 * Reading what a jar says about itself.
 *
 * The one question that matters operationally is `carriesRuntime`: a jar built
 * by `gatlingEnterprisePackage` deliberately has no Gatling in it, and the
 * runner must lend it one instead of launching a `java -cp` that cannot find
 * `io.gatling.app.Gatling`. Everything else here exists to stop that answer
 * being reached by accident.
 */
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'gatling-jar-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const jar = (name: string) => path.join(dir, name);

describe('readGatlingJar', () => {
  it('reports a thin package jar as carrying no runtime, and names its simulations', async () => {
    const file = jar('thin.jar');
    await writeJar(file, [
      {
        name: 'META-INF/MANIFEST.MF',
        content: gatlingManifest({
          'Gatling-Version': '3.15.1',
          'Gatling-Packager': 'gradle',
          'Gatling-Simulations': 'example.AssertionCorpus,example.BasicSimulation',
        }),
      },
      { name: 'example/BasicSimulation.class', content: 'not really bytecode' },
    ]);

    expect(await readGatlingJar(file)).toEqual({
      carriesRuntime: false,
      gatlingVersion: '3.15.1',
      simulations: ['example.AssertionCorpus', 'example.BasicSimulation'],
    });
  });

  // The wrap is not cosmetic. `Gatling-Simulations: ` plus two class names
  // exceeds 72 bytes, so a real packager splits the value across continuation
  // lines — and a parser that reads only the first line drops every simulation
  // after the wrap, which then reads as "this jar does not declare your class"
  // and rejects a perfectly good upload. The fixture wraps exactly as the jar
  // spec says, and this asserts the value is rejoined with no separator.
  it('rejoins a manifest value split across continuation lines', async () => {
    const many = [
      'com.example.very.long.package.name.CheckoutSoakSimulation',
      'com.example.very.long.package.name.CheckoutSmokeSimulation',
      'com.example.very.long.package.name.SearchSimulation',
    ];
    const manifest = gatlingManifest({ 'Gatling-Simulations': many.join(',') });
    expect(manifest.split('\r\n').some((line) => line.startsWith(' '))).toBe(true);

    const file = jar('wrapped.jar');
    await writeJar(file, [{ name: 'META-INF/MANIFEST.MF', content: manifest }]);

    expect((await readGatlingJar(file)).simulations).toEqual(many);
  });

  it('reports a fat jar as carrying its own runtime', async () => {
    const file = jar('fat.jar');
    await writeJar(file, [
      { name: GATLING_MAIN_CLASS, content: 'not really bytecode' },
      { name: 'example/BasicSimulation.class', content: 'not really bytecode' },
    ]);

    const facts = await readGatlingJar(file);
    expect(facts.carriesRuntime).toBe(true);
    // A shadow jar carries no Gatling manifest headers, and that absence must
    // read as "cannot check" rather than "declares nothing" — the API skips
    // simulation validation on exactly this signal.
    expect(facts.gatlingVersion).toBeNull();
    expect(facts.simulations).toEqual([]);
  });

  it('reads a stored (uncompressed) manifest as well as a deflated one', async () => {
    const file = jar('stored.jar');
    await writeJar(file, [
      {
        name: 'META-INF/MANIFEST.MF',
        content: gatlingManifest({ 'Gatling-Version': '3.13.5' }),
        stored: true,
      },
    ]);

    expect((await readGatlingJar(file)).gatlingVersion).toBe('3.13.5');
  });

  it('does not mistake the packager version for the framework version', async () => {
    // `Gatling-Packager-Version` is the PLUGIN's version — 3.15.1.2 for
    // framework 3.15.1 — and would never match a runtime, so reading it here
    // would fail every version check with a version nobody ships.
    const file = jar('packager.jar');
    await writeJar(file, [
      {
        name: 'META-INF/MANIFEST.MF',
        content: gatlingManifest({
          'Gatling-Version': '3.15.1',
          'Gatling-Packager-Version': '3.15.1.2',
        }),
      },
    ]);

    expect((await readGatlingJar(file)).gatlingVersion).toBe('3.15.1');
  });

  it('survives a jar with no manifest at all', async () => {
    const file = jar('bare.jar');
    await writeJar(file, [{ name: 'example/BasicSimulation.class', content: 'x' }]);

    expect(await readGatlingJar(file)).toEqual({
      carriesRuntime: false,
      gatlingVersion: null,
      simulations: [],
    });
  });

  it('refuses a file that is not a zip, rather than guessing', async () => {
    const file = jar('not-a-jar.jar');
    await writeFile(file, 'this is a text file someone renamed');

    await expect(readGatlingJar(file)).rejects.toBeInstanceOf(GatlingJarReadError);
  });

  it('refuses a file that does not exist', async () => {
    await expect(readGatlingJar(jar('absent.jar'))).rejects.toBeInstanceOf(GatlingJarReadError);
  });
});
