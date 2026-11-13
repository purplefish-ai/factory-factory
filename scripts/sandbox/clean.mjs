// `--clean`: remove sandboxes whose launcher is no longer running.
import { readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertInsideTempDir, sandboxRoot } from './paths.mjs';
import {
  collectGroupProcesses,
  isProcessRunning,
  isSandboxProcessGroup,
  realSystem,
  stopProcessGroup,
} from './process-group.mjs';
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
 * (`pid`) is no longer running.
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
    if (record && sameRealPath(record.baseDir, dir) && !isLauncherRunning(record.pid)) {
      selected.push({ dir, record });
    }
  }
  return selected;
}

/** Stops each selected sandbox's processes, then deletes its directory. */
export async function cleanSandboxes({
  root = sandboxRoot(),
  tempDir = tmpdir(),
  system = realSystem,
  remove = (dir) => rmSync(dir, { recursive: true, force: true }),
  log = () => undefined,
} = {}) {
  const removed = [];
  for (const { dir, record } of selectSandboxesToClean(root, (pid) =>
    isProcessRunning(pid, system)
  )) {
    assertInsideTempDir(dir, tempDir);
    if (isSandboxProcessGroup(record.pgid, record.baseDir, system)) {
      await stopProcessGroup(record.pgid, { system });
    } else if (collectGroupProcesses(system.listProcesses(), record.pgid).size > 0) {
      log(`Process group ${record.pgid} no longer belongs to ${dir}; leaving it running`);
    }
    remove(dir);
    log(`Removed ${dir}`);
    removed.push(dir);
  }
  return removed;
}
