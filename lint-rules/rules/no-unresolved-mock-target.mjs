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
// test files and test support under src/, scripts/ and lint-rules/.
import {
  isModuleMockCall,
  moduleMockTarget,
  resolveRepositoryModule,
  resolveRepositoryPath,
} from '../lib/module-mock.mjs';

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
        const specifier = moduleMockTarget(node.arguments[0]);
        const path =
          specifier === undefined ? undefined : resolveRepositoryPath(specifier, filename);
        if (path !== undefined && resolveRepositoryModule(path) === undefined) {
          context.report({
            node: node.arguments[0],
            message: `\`${specifier}\` does not resolve to a module, so this mock replaces nothing. Point it at the module's current path.`,
          });
        }
      },
    };
  },
};
