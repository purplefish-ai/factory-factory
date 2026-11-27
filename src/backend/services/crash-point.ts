/**
 * Crash points: places in server code where the dev sandbox can make the process die as a crash
 * would, so a restart scenario can prove what survives a crash at exactly that point.
 *
 * A crash point is declared where it is called, as `crashAt('<name>')` with a literal name made
 * of letters, digits, `_` and `-`; the sandbox's Playwright helpers find the declared names by
 * reading the source (`scripts/sandbox/crash-points.mjs`) and refuse to arm any other.
 *
 * Inert everywhere but the sandbox: `configService.getSandboxCrashPointDir()` is null unless the
 * sandbox's own variables are set, and then a call costs one `existsSync`. A spec arms a point by
 * creating the file `<dir>/<name>`; the first call that finds it deletes it (so the restarted
 * server runs unarmed) and kills the process with SIGKILL. Not `process.exit`: that runs exit
 * handlers, and a crash runs none, nor graceful shutdown, nor any pending write.
 */
import { existsSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { configService } from './config.service';

export function crashAt(name: string): void {
  const dir = configService.getSandboxCrashPointDir();
  if (dir === null) {
    return;
  }
  const armed = join(dir, name);
  if (!existsSync(armed)) {
    return;
  }
  rmSync(armed, { force: true });
  // Synchronous, so the line is written before the process dies; the logger may buffer.
  writeSync(2, `crash point ${name} reached: ending the process with SIGKILL\n`);
  process.kill(process.pid, 'SIGKILL');
}
