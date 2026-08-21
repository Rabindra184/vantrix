import { describe, expect, it } from 'vitest';
import { RunnerStartMetadataSchema } from '../src/runner.js';

const base = {
  name: 'checkout load',
  artifactKind: 'gatling_jar',
  simulationClass: 'com.example.CheckoutSimulation',
};

describe('RunnerStartMetadataSchema', () => {
  it('accepts JVM system property keys that are safe as -D arguments', () => {
    const parsed = RunnerStartMetadataSchema.parse({
      ...base,
      systemProperties: {
        'env.name': 'staging',
        'feature_flag-1': 'true',
      },
    });

    expect(parsed.systemProperties['env.name']).toBe('staging');
  });

  it('rejects JVM system property keys with shell/control characters', () => {
    expect(
      RunnerStartMetadataSchema.safeParse({
        ...base,
        systemProperties: {
          'bad key': 'x',
          'also=bad': 'y',
        },
      }).success,
    ).toBe(false);
  });
});
