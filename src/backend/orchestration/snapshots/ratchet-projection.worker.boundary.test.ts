import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  parseTypeScriptImports,
  REPOSITORY_ROOT,
} from '@/backend/testing/typescript-import-test-utils';

const workerPath = 'src/backend/orchestration/snapshots/ratchet-projection.worker.ts';

/** Module specifiers that a file loads at runtime; type-only imports are erased. */
function runtimeImports(file: string): string[] {
  const source = readFileSync(resolve(REPOSITORY_ROOT, file), 'utf8');
  return parseTypeScriptImports(source, file).importDeclarations.flatMap((declaration) => {
    const clause = declaration.importClause;
    const bindings = clause?.namedBindings;
    const typeOnly =
      clause?.isTypeOnly ||
      (bindings &&
        ts.isNamedImports(bindings) &&
        !clause?.name &&
        bindings.elements.every((binding) => binding.isTypeOnly));
    return !typeOnly && ts.isStringLiteral(declaration.moduleSpecifier)
      ? [declaration.moduleSpecifier.text]
      : [];
  });
}

it('loads only shared core at runtime, so reads and publication arrive as injected functions', () => {
  // No GitHub, PR delivery, session or Linear module can reach the worker; the
  // collector passes the workspace read, the store publication and a logger.
  expect(runtimeImports(workerPath)).toEqual(['@/shared/core']);
});
