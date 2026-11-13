// `vi.mock('<old path>')` of a module that moved or was deleted keeps running
// and replaces nothing, so the real module runs in the test and Vitest says
// nothing (docs/architecture/agent-friendly-codebase.md, principle 3). This
// rule asks the file system whether a repository-path target resolves, the way
// Vite does for the project's `@/` and `@prisma-gen/` aliases: the path as a
// file, with one of Vite's default extensions, or as a directory with an index
// file. Package and Node specifiers are not checked, and neither are targets
// Vitest resolves through `__mocks__` directories or `{ virtual: true }`, which
// the repository does not use. Existence is cached for the life of the process, so the editor
// language server needs a restart after a mocked file is created. Enabled for
// test files and test support under src/, scripts/, electron/ and lint-rules/.
import { statSync } from 'node:fs';
import { isModuleMockCall, literalValue, resolveRepositoryPath } from '../lib/module-mock.mjs';

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

/** Whether an absolute path names a module Vite would load. */
function resolves(path) {
  return (
    isFile(path) ||
    RESOLVE_EXTENSIONS.some((extension) => isFile(`${path}${extension}`)) ||
    (kindOf(path) === 'directory' &&
      RESOLVE_EXTENSIONS.some((extension) => isFile(`${path}/index${extension}`))) ||
    // TypeScript's ESM convention: a `.js` specifier names the `.ts` source.
    (path.endsWith('.js') && ['.ts', '.tsx'].some((ext) => isFile(`${path.slice(0, -3)}${ext}`)))
  );
}

export default {
  meta: {
    docs: {
      description:
        'Reject vi.mock and vi.doMock of a repository path (starting with @/, @prisma-gen/, ./, ../ or /src/) that resolves to no module: the mock replaces nothing. Only literal targets are checked.',
    },
  },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    return {
      CallExpression(node) {
        if (!isModuleMockCall(node)) {
          return;
        }
        const specifier = literalValue(node.arguments[0]);
        const path =
          specifier === undefined ? undefined : resolveRepositoryPath(specifier, filename);
        if (path !== undefined && !resolves(path)) {
          context.report({
            node: node.arguments[0],
            message: `\`${specifier}\` does not resolve to a module, so this mock replaces nothing. Point it at the module's current path.`,
          });
        }
      },
    };
  },
};
