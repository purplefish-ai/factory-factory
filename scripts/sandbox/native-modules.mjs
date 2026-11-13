// Builds the native modules (better-sqlite3, node-pty) for Node before the server starts. The
// server does this too, at the start of `ff serve`, but there it counts against the startup
// timeout, and a first build in a fresh checkout can take longer than that timeout.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.mjs';

const SCRIPT = join(REPO_ROOT, 'scripts', 'ensure-native-modules.mjs');
// What the script prints when it has nothing to do.
const NOTHING_TO_DO = /^Native modules already built for node/m;

/**
 * Runs `scripts/ensure-native-modules.mjs node` with the launcher's own environment, its output
 * on stderr (stdout carries only SANDBOX_READY). Resolves `{ rebuilt }`: false when the script
 * found the modules already built. Aborting `signal` ends the script.
 *
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {(command: string, args: string[], options: object) => any} [options.spawnImpl]
 * @param {{ write: (chunk: string | Buffer) => unknown }} [options.output]
 * @returns {Promise<{ rebuilt: boolean }>}
 */
export function ensureNativeModules({ signal, spawnImpl = spawn, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [SCRIPT, 'node'], {
      cwd: REPO_ROOT,
      signal,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk.toString();
      output.write(chunk);
    });
    child.once('error', reject);
    // 'close', not 'exit': every chunk of output has been read by then.
    child.once('close', (code, exitSignal) => {
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
