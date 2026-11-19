// Helpers for rules about `vi.mock` and `vi.doMock` targets.
import { statSync } from 'node:fs';
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
function literalValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return undefined;
}

/** The static target of a string or a type-checked `import('...')` mock. */
export function moduleMockTarget(node) {
  return literalValue(node?.type === 'ImportExpression' ? node.source : node);
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
    resolved = posix.join(posix.dirname(filename), specifier);
  } else {
    return undefined;
  }
  return posix.normalize(resolved).replace(/\/$/, '');
}

// Mirrors Vite's default `resolve.extensions`; no project configuration overrides
// it. They are appended to a target and tried as a directory's index file. A
// target written with its full file name resolves whatever its extension.
const RESOLVE_EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];

const kinds = new Map();

/** `'file'`, `'directory'` or `'none'` for an absolute path, cached. */
function kindOf(path) {
  let kind = kinds.get(path);
  if (kind === undefined) {
    const stats = statSync(path, { throwIfNoEntry: false });
    kind = stats?.isFile() ? 'file' : stats?.isDirectory() ? 'directory' : 'none';
    kinds.set(path, kind);
  }
  return kind;
}

const isFile = (path) => kindOf(path) === 'file';

/** Resolve an absolute repository path to the source file Vite would load. */
export function resolveRepositoryModule(path) {
  if (isFile(path)) {
    return path;
  }

  const withExtension = RESOLVE_EXTENSIONS.map((extension) => path + extension).find(isFile);
  if (withExtension !== undefined) {
    return withExtension;
  }

  if (kindOf(path) === 'directory') {
    const index = RESOLVE_EXTENSIONS.map((extension) => `${path}/index${extension}`).find(isFile);
    if (index !== undefined) {
      return index;
    }
  }

  // TypeScript's ESM convention: a JavaScript specifier may name its TS source.
  const sourceExtensions = path.endsWith('.js')
    ? ['.ts', '.tsx']
    : path.endsWith('.mjs')
      ? ['.mts']
      : [];
  return sourceExtensions
    .map((extension) => path.slice(0, path.lastIndexOf('.')) + extension)
    .find(isFile);
}
