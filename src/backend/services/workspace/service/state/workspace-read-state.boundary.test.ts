import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  parseTypeScriptImports,
  REPOSITORY_ROOT,
} from '@/backend/testing/typescript-import-test-utils';

function runtimeImports(source: string, fileName: string): string[] {
  return parseTypeScriptImports(source, fileName).importDeclarations.flatMap((declaration) => {
    const clause = declaration.importClause;
    if (clause?.isTypeOnly) {
      return [];
    }
    const bindings = clause?.namedBindings;
    if (
      bindings &&
      ts.isNamedImports(bindings) &&
      !clause?.name &&
      bindings.elements.every((binding) => binding.isTypeOnly)
    ) {
      return [];
    }
    return ts.isStringLiteral(declaration.moduleSpecifier)
      ? [declaration.moduleSpecifier.text]
      : [];
  });
}

function importsFrom(file: string): string[] {
  return runtimeImports(readFileSync(resolve(REPOSITORY_ROOT, file), 'utf8'), file);
}

describe('workspace read-state pure import boundary', () => {
  it('permits only shared session predicates at runtime, with no service or infrastructure dependencies', () => {
    expect(
      importsFrom('src/backend/services/workspace/service/state/workspace-read-state.ts')
    ).toEqual(['@/shared/session-runtime']);
  });

  it('keeps the permitted shared session predicates free of runtime dependencies', () => {
    expect(importsFrom('src/shared/session-runtime.ts')).toEqual([]);
  });

  it('ignores erased DTO/Prisma types while detecting runtime and side-effect imports', () => {
    const source = `
      import type { Workspace } from '@prisma-gen/client';
      import { type WorkspaceDerivedStateInput } from '@/backend/lib/workspace-derived-state';
      import { type SessionSummary, hasStartingSessionSummary } from '@/shared/session-runtime';
      import { configService } from '@/backend/services/config.service';
      import 'node:https';
    `;
    expect(runtimeImports(source, 'fixture.ts')).toEqual([
      '@/shared/session-runtime',
      '@/backend/services/config.service',
      'node:https',
    ]);
  });
});
