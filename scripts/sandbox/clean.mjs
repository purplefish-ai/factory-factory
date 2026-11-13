// `--clean`: remove sandboxes whose launcher is no longer running.
import { readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertInsideTempDir, sandboxRoot } from './paths.mjs';
import { isSameProcess, realSystem, stopProcessGroup } from './process-group.mjs';
import { readSandboxRecord } from './record.mjs';

function sameRealPath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/**
 * Sandboxes `--clean` may remove: directories under `root` holding a valid
 * `sandbox.json` that names that same directory as `baseDir`, whose launcher
 * is no longer running.
 */
export function selectSandboxesToClean(root, isLauncherRunning) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const selected = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = join(root, entry.name);
    const record = readSandboxRecord(join(dir, 'sandbox.json'));
    if (record && sameRealPath(record.baseDir, dir) && !isLauncherRunning(record)) {
      selected.push({ dir, record });
    }
  }
  return selected;
}

/**
 * Stops each selected sandbox's processes, then deletes its directory. A
 * launcher counts as running only while its pid has its recorded start time,
 * and a group is signalled only while its leader's pid has its recorded one.
 */
export async function cleanSandboxes({
  root = sandboxRoot(),
  tempDir = tmpdir(),
  system = realSystem,
  remove = (dir) => rmSync(dir, { recursive: true, force: true }),
  log = () => undefined,
} = {}) {
  const processes = system.listProcesses();
  const removed = [];
  for (const { dir, record } of selectSandboxesToClean(root, (launcher) =>
    isSameProcess(processes, { pid: launcher.pid, startedAt: launcher.pidStartedAt })
  )) {
    assertInsideTempDir(dir, tempDir);
    if (record.pgid !== null) {
      const { owned } = await stopProcessGroup(record.pgid, {
        system,
        leaderStartedAt: record.pgidStartedAt,
      });
      if (!owned) {
        log(`Process group ${record.pgid} no longer belongs to ${dir}; leaving it running`);
      }
    }
    remove(dir);
    log(`Removed ${dir}`);
    removed.push(dir);
  }
  return removed;
}
