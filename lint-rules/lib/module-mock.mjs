// Helpers for rules about `vi.mock` and `vi.doMock` targets.
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMember } from './ast.mjs';

/** The repository root, anchored on this file so results do not depend on the working directory. */
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
  .replaceAll('\\', '/')
  .replace(/\/$/, '');

/** Whether `node` is a `vi.mock(...)` or `vi.doMock(...)` call. */
export function isModuleMockCall(node) {
  return isMember(node.callee, 'vi', 'mock') || isMember(node.callee, 'vi', 'doMock');
}

/** A string literal, or a template literal without substitutions. */
export function literalValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return undefined;
}

/**
 * The absolute path a repository module specifier names, written from the test
 * at `filename`: `@/` is `src/`, `@prisma-gen/` is `prisma/generated/`, `/src/`
 * is Vite's root-relative form, and `.`, `..`, `./` and `../` are relative to
 * the test. Anything else is a package or Node specifier: `undefined`.
 */
export function resolveRepositoryPath(specifier, filename) {
  let resolved;
  if (specifier.startsWith('@/')) {
    resolved = posix.join(repositoryRoot, 'src', specifier.slice(2));
  } else if (specifier.startsWith('@prisma-gen/')) {
    resolved = posix.join(repositoryRoot, 'prisma/generated', specifier.slice(12));
  } else if (specifier.startsWith('/src/')) {
    resolved = posix.join(repositoryRoot, specifier);
  } else if (specifier === '.' || specifier === '..' || /^\.\.?\//.test(specifier)) {
    resolved = posix.resolve(posix.dirname(filename), specifier);
  } else {
    return undefined;
  }
  return posix.normalize(resolved).replace(/\/$/, '');
}
