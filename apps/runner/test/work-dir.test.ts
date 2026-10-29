import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/process.js', () => ({ spawnAndWait: vi.fn() }));

import { spawnAndWait } from '../src/process.js';
import { removeWorkDir } from '../src/work-dir.js';

/**
 * ═══ THE SIMULATION's FILES ARE ITS UID's, AND ROOT HERE CANNOT UNLINK THEM ═══
 *
 * Gatling, running as `RUNNER_CHILD_UID`, creates `results/<simulation>/` 755
 * and writes the whole `simulation.log` inside it. The compose runner is root
 * with `cap_drop: ALL` — no `CAP_DAC_OVERRIDE` — so to that directory it is
 * "other", and every job's `rm` failed `EACCES` and left the log on the
 * volume. The runner keeps `CAP_SETUID`, so the pass that can delete them runs
 * as their owner, and the runner's own `rm` then takes what is left.
 *
 * These cases cannot change uid (the suite does not run as root), so they pin
 * the ORDER and the ARGUMENTS; the container run in this branch's CLAUDE.md
 * entry is what proves the files go.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'runner-workdir-'));
  vi.mocked(spawnAndWait).mockReset();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function jobDir(): Promise<string> {
  const dir = path.join(root, 'job');
  await mkdir(path.join(dir, 'results', 'basicsimulation-1'), { recursive: true });
  await writeFile(path.join(dir, 'results', 'basicsimulation-1', 'simulation.log'), 'x');
  await mkdir(path.join(dir, 'tmp'));
  return dir;
}

const gone = async (p: string) => expect(stat(p)).rejects.toMatchObject({ code: 'ENOENT' });

describe('removeWorkDir', () => {
  it("deletes the directory's entries as the simulation's uid, then the directory itself", async () => {
    const dir = await jobDir();
    let existedDuringChildPass = false;
    vi.mocked(spawnAndWait).mockImplementation(async () => {
      existedDuringChildPass = (await stat(dir).catch(() => null)) !== null;
      return { code: 0, signal: null, stopped: false };
    });

    await removeWorkDir(dir, { uid: 20001, gid: 20001 });

    expect(spawnAndWait).toHaveBeenCalledTimes(1);
    const [command] = vi.mocked(spawnAndWait).mock.calls[0]!;
    expect(command.command).toBe('rm');
    expect(command.uid).toBe(20001);
    expect(command.gid).toBe(20001);
    // Every entry, by absolute path, behind `--` so a name cannot be read as a flag.
    expect(command.args.slice(0, 2)).toEqual(['-rf', '--']);
    expect([...command.args.slice(2)].sort()).toEqual([path.join(dir, 'results'), path.join(dir, 'tmp')]);
    // The child cannot remove the directory itself (its parent is the
    // runner's), so the runner's own pass comes after and does.
    expect(existedDuringChildPass).toBe(true);
    await gone(dir);
  });

  it('spawns nothing when the simulation runs as the runner itself', async () => {
    const dir = await jobDir();

    await removeWorkDir(dir, { uid: undefined, gid: undefined });

    expect(spawnAndWait).not.toHaveBeenCalled();
    await gone(dir);
  });

  it('still removes what it can when the pass as the child fails', async () => {
    const dir = await jobDir();
    vi.mocked(spawnAndWait).mockResolvedValue({ code: 1, signal: null, stopped: false });

    await removeWorkDir(dir, { uid: 20001, gid: 20001 });

    await gone(dir);
  });

  it('spawns nothing for a directory that is already gone', async () => {
    await removeWorkDir(path.join(root, 'never-made'), { uid: 20001, gid: 20001 });

    expect(spawnAndWait).not.toHaveBeenCalled();
  });
});
