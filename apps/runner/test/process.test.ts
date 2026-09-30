import { describe, expect, it, vi } from 'vitest';
import { spawnAndWait } from '../src/process.js';

/**
 * `onSpawn` is when the runner may say "Gatling process started": the OS has
 * reported the process running. A command that could not be launched must
 * never get that line.
 */
describe('spawnAndWait — onSpawn', () => {
  it('reports the process started before it reports it ended', async () => {
    const order: string[] = [];
    const result = await spawnAndWait(
      { command: process.execPath, args: ['-e', ''], cwd: process.cwd() },
      { onSpawn: () => order.push('spawned') },
    );
    order.push('closed');
    expect(result.code).toBe(0);
    expect(order).toEqual(['spawned', 'closed']);
  });

  it('never reports a start for a command that could not be launched', async () => {
    const onSpawn = vi.fn();
    await expect(spawnAndWait(
      { command: '/nonexistent/perfportal-no-such-binary', args: [], cwd: process.cwd() },
      { onSpawn },
    )).rejects.toThrow(/ENOENT/);
    expect(onSpawn).not.toHaveBeenCalled();
  });
});
