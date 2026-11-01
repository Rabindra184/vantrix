import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnAndWait } from './process.js';

/**
 * Removes a job's work directory, the simulation's own files included.
 *
 * ═══ ROOT HERE CANNOT DELETE WHAT THE SIMULATION WROTE ═══
 *
 * Gatling runs as `RUNNER_CHILD_UID` and creates `results/<simulation>/` with
 * mode 755, writing the whole `simulation.log` inside it. The compose runner is
 * root with `cap_drop: ALL`, so it has no `CAP_DAC_OVERRIDE`: to that directory
 * it is "other", and unlinking inside it fails `EACCES`. Every job's cleanup
 * therefore left its full log on the runner volume — the GE side-by-side proof
 * found four, one per job — and a soak test's log is gigabytes.
 *
 * The runner does keep `CAP_SETUID`, which is how it starts the simulation as
 * that uid at all, so the pass that can delete those files runs AS THEIR OWNER:
 * `rm -rf` over the directory's entries, as the child uid. Every directory the
 * runner itself made is opened 777 by `makeChildWritable`, so that uid can
 * remove those too. It cannot remove the work directory ITSELF — its parent is
 * the runner's own 755 directory — so the runner's `rm` follows and takes the
 * directory and anything the first pass left.
 *
 * A failed first pass is not an error here: the runner's own pass still runs,
 * and if something is still undeletable that pass throws `EACCES`, which is
 * the fact the caller logs.
 */
export async function removeWorkDir(
  dir: string,
  owner: { uid: number | undefined; gid: number | undefined },
): Promise<void> {
  if (owner.uid !== undefined) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    if (entries.length > 0) {
      await spawnAndWait({
        command: 'rm',
        args: ['-rf', '--', ...entries.map((entry) => path.join(dir, entry))],
        cwd: dir,
        uid: owner.uid,
        gid: owner.gid,
      }).catch(() => undefined);
    }
  }
  await rm(dir, { recursive: true, force: true });
}
