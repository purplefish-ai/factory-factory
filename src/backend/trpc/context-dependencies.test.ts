import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  discoverProductionTypeScriptFiles,
  parseTypeScriptImports,
  REPOSITORY_ROOT,
  resolveRepositoryModule,
} from '@/backend/testing/typescript-import-test-utils';

const TRPC_ROOT = resolve(REPOSITORY_ROOT, 'src/backend/trpc');

const TRPC_RUNTIME_FILES = discoverProductionTypeScriptFiles(TRPC_ROOT);

const ALLOWED_PURE_BACKEND_IMPORTS = new Map<string, ReadonlySet<string>>([
  ['src/backend/services/github', new Set(['classifyGitHubCLIError'])],
  ['src/backend/services/git-clone.service', new Set(['parseGithubUrl'])],
  [
    'src/backend/services/workspace',
    new Set([
      'computeKanbanColumn',
      'computePendingRequestType',
      'deriveWorkspaceFlowStateFromWorkspace',
      'getWorkspaceInitPolicy',
    ]),
  ],
]);

function isBackendRuntimeModule(repositoryPath: string): boolean {
  return /^src\/backend\/(?:services|orchestration|db)(?:\/|$)/.test(repositoryPath);
}

function importViolation(moduleSpecifier: string, binding: string): string {
  return `${moduleSpecifier}#${binding}`;
}

function findNamedBindingViolations(
  moduleSpecifier: string,
  namedBindings: ts.NamedImportBindings
): string[] {
  if (ts.isNamespaceImport(namedBindings)) {
    return [importViolation(moduleSpecifier, '*')];
  }

  const allowedBindings = ALLOWED_PURE_BACKEND_IMPORTS.get(moduleSpecifier);
  return namedBindings.elements.flatMap((element) => {
    if (element.isTypeOnly) {
      return [];
    }

    const importedName = element.propertyName?.text ?? element.name.text;
    return allowedBindings?.has(importedName)
      ? []
      : [importViolation(moduleSpecifier, importedName)];
  });
}

function findImportDeclarationViolations(
  importer: string,
  statement: ts.ImportDeclaration
): string[] {
  if (!ts.isStringLiteral(statement.moduleSpecifier)) {
    return [];
  }

  const moduleSpecifier = resolveRepositoryModule(importer, statement.moduleSpecifier.text);
  if (!(moduleSpecifier && isBackendRuntimeModule(moduleSpecifier))) {
    return [];
  }

  const importClause = statement.importClause;
  if (!importClause) {
    return [importViolation(moduleSpecifier, 'side-effect')];
  }
  if (importClause.isTypeOnly) {
    return [];
  }

  const violations = importClause.name ? [importViolation(moduleSpecifier, 'default')] : [];
  if (importClause.namedBindings) {
    violations.push(...findNamedBindingViolations(moduleSpecifier, importClause.namedBindings));
  }
  return violations;
}

function findForbiddenBackendImports(
  source: string,
  importer = 'src/backend/trpc/runtime-imports.ts'
): string[] {
  const { importDeclarations } = parseTypeScriptImports(source, importer);
  return importDeclarations.flatMap((statement) =>
    findImportDeclarationViolations(importer, statement)
  );
}

describe('tRPC context dependencies', () => {
  it('discovers all production tRPC modules and helpers', () => {
    expect(TRPC_RUNTIME_FILES).toEqual(
      expect.arrayContaining([
        'src/backend/trpc/index.ts',
        'src/backend/trpc/issue-filter.ts',
        'src/backend/trpc/log-file-reader.ts',
        'src/backend/trpc/procedures/project-scoped.ts',
        'src/backend/trpc/trpc.ts',
      ])
    );
    expect(TRPC_RUNTIME_FILES.some((file) => file.endsWith('.test.ts'))).toBe(false);
  });

  it.each(TRPC_RUNTIME_FILES)('%s uses context runtime dependencies', (file) => {
    const source = readFileSync(resolve(REPOSITORY_ROOT, file), 'utf8');

    expect(findForbiddenBackendImports(source, file), file).toEqual([]);
  });

  describe('import classification', () => {
    it('rejects unknown named runtime bindings without spanning import declarations', () => {
      const source = `
        import { z } from 'zod';
        import {
          parseGithubUrl,
          unknownRuntime as renamedRuntime,
        } from '@/backend/services/git-clone.service';
        import type { WorkspaceWithProject } from '@/backend/orchestration/types';
      `;

      expect(findForbiddenBackendImports(source)).toEqual([
        'src/backend/services/git-clone.service#unknownRuntime',
      ]);
    });

    it('rejects namespace, default, and side-effect imports from runtime modules', () => {
      expect(
        findForbiddenBackendImports(`
          import runtimeDefault from '@/backend/services/session';
          import * as workspaceRuntime from '@/backend/services/workspace';
          import '@/backend/orchestration/reconciliation.service';
        `)
      ).toEqual([
        'src/backend/services/session#default',
        'src/backend/services/workspace#*',
        'src/backend/orchestration/reconciliation.service#side-effect',
      ]);
    });

    it('rejects relative and absolute imports of backend runtime modules', () => {
      const absoluteSessionPath = resolve(process.cwd(), 'src/backend/services/session/index.ts');

      expect(
        findForbiddenBackendImports(
          `
            import { workspaceService } from '../services/workspace';
            import sessionRuntime from '${absoluteSessionPath}';
          `,
          'src/backend/trpc/new.trpc.ts'
        )
      ).toEqual([
        'src/backend/services/workspace#workspaceService',
        'src/backend/services/session/index#default',
      ]);
    });

    it('allows type-only imports and explicitly approved pure helpers', () => {
      expect(
        findForbiddenBackendImports(`
          import type { ClosedSessionTranscript } from '@/backend/services/session';
          import {
            classifyGitHubCLIError,
            type GitHubCLIHealthStatus,
          } from '@/backend/services/github';
          import { parseGithubUrl as parseRepositoryUrl } from '@/backend/services/git-clone.service';
        `)
      ).toEqual([]);
    });
  });
});
