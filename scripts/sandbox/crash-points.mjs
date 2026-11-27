// Crash points (src/backend/services/crash-point.ts): which ones server code declares, and arming
// one in a running sandbox. The declared set is read from the source, so it cannot drift from the
// calls: every `crashAt('<name>')` outside tests under src/backend, with a literal name.
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { REPO_ROOT } from './paths.mjs';

/** A crash point's name, which is also its file name in the sandbox's crash point directory. */
export const CRASH_POINT_NAME = /^[A-Za-z0-9_-]+$/;

/** The module that defines `crashAt`; its own text mentions the call without declaring a point. */
const DEFINITION = ['src', 'backend', 'services', 'crash-point.ts'].join(sep);
const NOT_PRODUCTION = /\.(test|test-helpers|integration\.test)\.tsx?$/;

/**
 * The names declared by `crashAt('<name>')` calls in non-test TypeScript under `root/src/backend`,
 * sorted. Throws on a call without a literal name, or a name declared in two places.
 *
 * @param {string} [root]
 * @returns {string[]}
 */
export function declaredCrashPoints(root = REPO_ROOT) {
  const backend = join(root, 'src', 'backend');
  const declared = new Map();
  for (const entry of readdirSync(backend, { recursive: true })) {
    const file = String(entry);
    const path = join(backend, file);
    if (!/\.tsx?$/.test(file) || NOT_PRODUCTION.test(file) || relative(root, path) === DEFINITION) {
      continue;
    }
    const source = readFileSync(path, 'utf8');
    for (const call of source.matchAll(/\bcrashAt\(([^)]*)\)/g)) {
      const where = relative(root, path);
      const name = /^\s*'([^']*)'\s*$/.exec(call[1])?.[1];
      if (!(name && CRASH_POINT_NAME.test(name))) {
        throw new Error(
          `${where}: ${call[0]} must name its crash point with a literal of letters, digits, "_" or "-".`
        );
      }
      if (declared.has(name)) {
        throw new Error(
          `Crash point "${name}" is declared twice: ${declared.get(name)} and ${where}.`
        );
      }
      declared.set(name, where);
    }
  }
  return [...declared.keys()].sort();
}

/**
 * Arms `name` in a sandbox: the next time the server reaches `crashAt(name)` it dies with SIGKILL
 * and the point disarms itself. Fails for a name no code declares, and for a point already armed.
 *
 * @param {string} crashPointDir the sandbox's `crashPointDir` (scripts/sandbox/paths.mjs)
 * @param {string} name
 * @param {string[]} [declared]
 */
export function armCrashPoint(crashPointDir, name, declared = declaredCrashPoints()) {
  if (!declared.includes(name)) {
    throw new Error(
      `No code declares crash point ${JSON.stringify(name)}; declared: ${declared.join(', ') || 'none'}.`
    );
  }
  writeFileSync(join(crashPointDir, name), '', { flag: 'wx' });
}

/** Disarms `name` if it is armed. */
export function disarmCrashPoint(crashPointDir, name) {
  if (!CRASH_POINT_NAME.test(name)) {
    throw new Error(`Crash point name ${JSON.stringify(name)} must match ${CRASH_POINT_NAME}.`);
  }
  rmSync(join(crashPointDir, name), { force: true });
}
