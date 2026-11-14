import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  parseTypeScriptImports,
  REPOSITORY_ROOT,
} from '@/backend/testing/typescript-import-test-utils';

const workerPath = 'src/backend/orchestration/snapshots/ratchet-projection.worker.ts';

function isTypeOnlyImport(declaration: ts.ImportDeclaration): boolean {
  const clause = declaration.importClause;
  const bindings = clause?.namedBindings;
  return Boolean(
    clause?.isTypeOnly ||
    (bindings &&
      ts.isNamedImports(bindings) &&
      !clause?.name &&
      bindings.elements.every((binding) => binding.isTypeOnly))
  );
}

/**
 * Module specifiers a file loads at runtime: value imports, side-effect
 * imports, `export … from`, `import()` and `require()`. Type-only imports and
 * re-exports are erased.
 */
function runtimeModules(source: string, fileName: string): string[] {
  const { sourceFile } = parseTypeScriptImports(source, fileName);
  const modules: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      !isTypeOnlyImport(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      modules.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      modules.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const [specifier] = node.arguments;
      modules.push(specifier && ts.isStringLiteral(specifier) ? specifier.text : '<dynamic>');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return modules;
}

it('loads only shared core at runtime, so reads and publication arrive as injected functions', () => {
  // No GitHub, PR delivery, session or Linear module can reach the worker; the
  // collector passes the workspace read, the store publication and a logger.
  const source = readFileSync(resolve(REPOSITORY_ROOT, workerPath), 'utf8');
  expect(runtimeModules(source, workerPath)).toEqual(['@/shared/core']);
});

it('counts re-exports and dynamic loads but not erased type imports', () => {
  const source = `
    import type { Logger } from '@/backend/services/logger.service';
    import { type SnapshotUpdateInput } from '@/backend/services/workspace';
    import { WorkspaceStatus } from '@/shared/core';
    import '@/backend/services/session';
    export { githubService } from '@/backend/services/github';
    export type { Contract } from '@/backend/services/linear';
    const load = () => import('@/backend/services/linear');
    const legacy = require('@/backend/orchestration/pull-requests/pr-event-delivery-port');
  `;
  expect(runtimeModules(source, 'fixture.ts')).toEqual([
    '@/shared/core',
    '@/backend/services/session',
    '@/backend/services/github',
    '@/backend/services/linear',
    '@/backend/orchestration/pull-requests/pr-event-delivery-port',
  ]);
});
