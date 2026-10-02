import { describe, expect, it } from 'vitest';
import { assertSimulationListed, packageNameFromFilename } from '../src/runner/package-files.js';

describe('a package name from a filename', () => {
  it.each([
    ['gatling-gradle-plugin-demo-kotlin-main-tests.jar', 'gatling-gradle-plugin-demo-kotlin-main-tests'],
    ['load.tar.gz', 'load'],
    ['Load.TAR.GZ', 'Load'],
    ['bundle.zip', 'bundle'],
    ['archive', 'archive'],
    ['.jar', 'package'],
  ])('%s → %s', (filename, name) => {
    expect(packageNameFromFilename(filename)).toBe(name);
  });

  it('caps the stem at 112 characters, as the backfill does', () => {
    expect(packageNameFromFilename(`${'x'.repeat(200)}.jar`)).toHaveLength(112);
  });
});

describe('checking a class against what the jar declares', () => {
  it('cannot check, and so accepts, when the list is unknown', () => {
    expect(() => assertSimulationListed(null, 'any.Thing')).not.toThrow();
  });
  it('refuses a class the list does not hold, naming the ones it does', () => {
    let thrown: unknown;
    try {
      assertSimulationListed(['a.One', 'a.Two'], 'a.Three');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'SIMULATION_CLASS_NOT_IN_ARTIFACT' });
    // The list is the REMEDIATION's job — what to type instead — which is where
    // runner.integration.test.ts has always asserted it; the message says what
    // was wrong, not how to fix it.
    expect((thrown as { remediation: string }).remediation).toMatch(/a\.One, a\.Two/);
  });
});
