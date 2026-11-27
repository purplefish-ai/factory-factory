// Crash points (src/backend/services/crash-point.ts): which ones server code declares, and arming
// one in a running sandbox. The declared set is read from the source, so it cannot drift from the
// calls: every `crashAt('<name>')` call outside tests under src/backend, with a literal name.
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { REPO_ROOT } from './paths.mjs';

/** A crash point's name, which is also its file name in the sandbox's crash point directory. */
export const CRASH_POINT_NAME = /^[A-Za-z0-9_-]+$/;

const NOT_PRODUCTION = /\.(test|test-helpers|integration\.test)\.tsx?$/;

/** The `crashAt(...)` calls in `source`, parsed: comments and strings that mention one are not. */
function crashAtCalls(file, source) {
  const calls = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'crashAt'
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
  return calls;
}

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
    if (!/\.tsx?$/.test(file) || NOT_PRODUCTION.test(file)) {
      continue;
    }
    const path = join(backend, file);
    const source = readFileSync(path, 'utf8');
    if (!source.includes('crashAt')) {
      continue;
    }
    const where = relative(root, path);
    for (const call of crashAtCalls(path, source)) {
      const [argument] = call.arguments;
      const name =
        call.arguments.length === 1 && argument && ts.isStringLiteral(argument)
          ? argument.text
          : null;
      if (!(name && CRASH_POINT_NAME.test(name))) {
        throw new Error(
          `${where}: ${call.getText()} must name its crash point with a literal of letters, digits, "_" or "-".`
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
