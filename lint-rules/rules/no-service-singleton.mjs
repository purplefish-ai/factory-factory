// A service built at module level (`export const fooService = new FooService()`)
// is a global every importer reaches directly, so tests must mock the module to
// replace it and its dependencies cannot be passed in. Export the class, and
// where it needs wiring a `createFooService(dependencies)` factory beside it
// (`createRunScriptService` in
// src/backend/services/run-script/service/run-script.service.ts is the model),
// and construct the instance once in the composition root:
// src/backend/app-context.ts (`createApplication`) or a subsystem module it
// calls, such as src/backend/orchestration/pull-requests/ratchet-dependencies.ts.
// Enabled for src/backend, outside tests and test support.
//
// What the rule matches, in files that are not excepted:
// - `export const x = new X(...)` (also `let` and `var`), with or without a
//   type annotation, `as` or `satisfies`;
// - `const x = new X(...); export { x }` or `export { x as y }`, and
//   `export default x`;
// - `export default new X(...)`;
// where X is a class declared in the same file, imported from a repository
// module (a relative path or `@/...`), or a member of a namespace imported from
// one (`new services.FooService()`). Built-ins (`Map`, `Set`, `WeakMap`,
// `Date`, `URL`, `RegExp`, `AbortController`, `AsyncLocalStorage`), classes from
// packages and from `@prisma-gen/` (`PrismaClient`) and error classes (a name
// ending in `Error`) are not the target.
//
// Accessors under `resources/` are in scope: a test replaces
// `workspaceAccessor` by mocking its module, as it does a service, so the
// class-instance accessor has the same cost. An accessor written as an object of
// functions is not a `new`, and is not matched.
//
// Exceptions are per file: a new instance in an excepted file still passes. The
// list can shrink and no file can join it.
//
// What it does not match: a singleton made by a call (`export const x =
// createX()`, `Object.freeze({ ... })`), a `let x; x = new X()` assigned after
// its declaration, and a non-exported module-level instance. They exist today
// (`serverInstanceService`, `sessionDomainService`, `acpRuntimeManager` and
// others) and are the same problem under another spelling; this rule only keeps
// the `new` form from spreading.
import { unwrapExpression } from '../lib/ast.mjs';
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';
import { isTestSupportFile } from '../lib/test-support.mjs';
import exceptions from './no-service-singleton.exceptions.json' with { type: 'json' };

const MESSAGE =
  'Do not construct a service at module level. Export the class (and a createXService(dependencies) factory when it needs wiring) and construct the instance in the composition root: src/backend/app-context.ts or the subsystem module it calls. See createRunScriptService.';

function isRepositorySource(source) {
  return source.startsWith('.') || source.startsWith('@/');
}

/** The statement's own declaration: the `export` is looked through. */
function declarationOf(statement) {
  return statement.type === 'ExportNamedDeclaration' ||
    statement.type === 'ExportDefaultDeclaration'
    ? statement.declaration
    : statement;
}

export default {
  meta: {
    docs: {
      description:
        "Reject a module-level instance of the repository's own class under src/backend (`export const x = new X()`, `const x = new X(); export { x }`, `export default new X()`); export the class or a createX factory and construct it in the composition root (src/backend/app-context.ts). Built-ins, package and Prisma classes and Error classes are allowed; a singleton made by calling a factory function is not detected. Test and test-support files are exempt.",
    },
    schema: EXCEPTIONS_SCHEMA,
  },
  create(context) {
    if (isTestSupportFile(context) || isExceptedFile(context, exceptions)) {
      return {};
    }
    return {
      Program(program) {
        // The classes this file can name, so a `new` is judged by what it builds.
        const classes = new Set();
        const namespaces = new Set();
        for (const statement of program.body) {
          if (statement.type === 'ImportDeclaration') {
            if (statement.importKind !== 'type' && isRepositorySource(statement.source.value)) {
              for (const specifier of statement.specifiers) {
                if (specifier.importKind === 'type') {
                  continue;
                }
                (specifier.type === 'ImportNamespaceSpecifier' ? namespaces : classes).add(
                  specifier.local.name
                );
              }
            }
          } else {
            const declaration = declarationOf(statement);
            if (declaration?.type === 'ClassDeclaration' && declaration.id) {
              classes.add(declaration.id.name);
            }
          }
        }
        const isRepositoryClass = (callee) => {
          if (callee.type === 'Identifier') {
            return classes.has(callee.name) && !callee.name.endsWith('Error');
          }
          return (
            callee.type === 'MemberExpression' &&
            !callee.computed &&
            callee.object.type === 'Identifier' &&
            namespaces.has(callee.object.name) &&
            !callee.property.name.endsWith('Error')
          );
        };
        const isRepositoryInstance = (init) => {
          const expression = unwrapExpression(init);
          return (
            expression?.type === 'NewExpression' &&
            isRepositoryClass(unwrapExpression(expression.callee))
          );
        };

        // Module-level `const x = new X()`, exported where it is declared or by name.
        const instances = new Map();
        const exportedWhereDeclared = [];
        for (const statement of program.body) {
          const declaration = declarationOf(statement);
          if (declaration?.type !== 'VariableDeclaration') {
            continue;
          }
          for (const declarator of declaration.declarations) {
            if (declarator.id.type === 'Identifier' && isRepositoryInstance(declarator.init)) {
              instances.set(declarator.id.name, declarator);
              if (statement.type === 'ExportNamedDeclaration') {
                exportedWhereDeclared.push(declarator);
              }
            }
          }
        }

        const flagged = new Set(exportedWhereDeclared);
        const flag = (node) => {
          if (node) {
            flagged.add(node);
          }
        };
        for (const statement of program.body) {
          if (statement.type === 'ExportDefaultDeclaration') {
            const exported = unwrapExpression(statement.declaration);
            if (isRepositoryInstance(exported)) {
              flag(exported);
            } else if (exported?.type === 'Identifier') {
              flag(instances.get(exported.name));
            }
          } else if (
            statement.type === 'ExportNamedDeclaration' &&
            !statement.declaration &&
            !statement.source
          ) {
            for (const specifier of statement.specifiers) {
              if (specifier.exportKind !== 'type') {
                flag(instances.get(specifier.local.name));
              }
            }
          }
        }
        for (const node of flagged) {
          context.report({ node, message: MESSAGE });
        }
      },
    };
  },
};
