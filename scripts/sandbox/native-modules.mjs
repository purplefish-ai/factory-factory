// Builds the native modules (better-sqlite3, node-pty) for Node before the server starts. The
// server does this too, at the start of `ff serve`, but there it counts against the startup
// timeout, and a first build in a fresh checkout can take longer than that timeout.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.mjs';
import { STOP_GRACE_MS } from './process-group.mjs';

const SCRIPT = join(REPO_ROOT, 'scripts', 'ensure-native-modules.mjs');
// What the script prints when it has nothing to do.
const NOTHING_TO_DO = /^Native modules already built for node/m;

/**
 * Runs `scripts/ensure-native-modules.mjs node` with the launcher's own environment, its output
 * on stderr (stdout carries only SANDBOX_READY). Resolves `{ rebuilt }`: false when the script
 * found the modules already built. Aborting `signal` ends the script and everything it started
 * (`pnpm rebuild`, node-gyp): it runs in its own process group, which gets SIGTERM and, if the
 * script is still running after the grace period, SIGKILL. The group is signalled only while the
 * script's process is unreaped, checked in the same step as each signal: once Node has reaped it,
 * its pid, and so the group ID, may belong to someone else.
 *
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {(command: string, args: string[], options: object) => any} [options.spawnImpl]
 * @param {(target: number, signal: string) => unknown} [options.kill]
 * @param {(run: () => void, ms: number) => any} [options.schedule]
 * @param {(timer: any) => void} [options.cancel]
 * @param {number} [options.graceMs]
 * @param {{ write: (chunk: string | Buffer) => unknown }} [options.output]
 * @returns {Promise<{ rebuilt: boolean }>}
 */
export function ensureNativeModules({
  signal,
  spawnImpl = spawn,
  kill = (target, killSignal) => process.kill(target, killSignal),
  schedule = setTimeout,
  cancel = clearTimeout,
  graceMs = STOP_GRACE_MS,
  output = process.stderr,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [SCRIPT, 'node'], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const unreaped = () =>
      Boolean(child.pid) && child.exitCode === null && child.signalCode === null;
    // True when the group was signalled (or had already ended).
    const signalGroup = (name) => {
      if (!unreaped()) {
        return false;
      }
      try {
        kill(-child.pid, name);
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          reject(error);
        }
      }
      return true;
    };
    let killTimer = null;
    const endGroup = () => {
      if (signalGroup('SIGTERM')) {
        killTimer = schedule(() => signalGroup('SIGKILL'), graceMs);
      }
    };
    if (signal?.aborted) {
      endGroup();
    }
    signal?.addEventListener('abort', endGroup, { once: true });
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk.toString();
      output.write(chunk);
    });
    child.once('error', reject);
    // 'close', not 'exit': every chunk of output has been read by then.
    child.once('close', (code, exitSignal) => {
      signal?.removeEventListener('abort', endGroup);
      if (killTimer !== null) {
        cancel(killTimer);
      }
      if (code === 0) {
        resolve({ rebuilt: !NOTHING_TO_DO.test(text) });
      } else {
        reject(
          new Error(
            `Building the native modules failed (${exitSignal ?? `exit code ${code}`}); its output is above. Run node scripts/ensure-native-modules.mjs node to retry.`
          )
        );
      }
    });
  });
}
