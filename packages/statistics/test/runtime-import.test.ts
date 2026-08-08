import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Vitest reads package SOURCE, so it cannot catch a package that is unimportable
 * by Node itself. Shell out to a real node process — that is the only way this
 * failure mode is observable, and it is how apps/api and apps/worker will load it.
 */
describe('runtime importability', () => {
  it('loads @perfportal/statistics in a plain node process', () => {
    const script = `
      const { Sketch } = await import('@perfportal/statistics');
      const s = new Sketch();
      for (let i = 1; i <= 1000; i++) s.accept(i);
      if (!(Math.abs(s.quantile(0.95) - 950) / 950 <= 0.01)) throw new Error('p95 out of tolerance');
      console.log('ok');
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('ok');
  });

  it('loads @perfportal/plugin-gatling in a plain node process', () => {
    const script = `
      const m = await import('@perfportal/plugin-gatling');
      if (typeof m.parseSimulationLog !== 'function') throw new Error('missing parseSimulationLog');
      console.log('ok');
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('ok');
  });
});
