import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TRPC_ROOT = resolve(process.cwd(), 'src/backend/trpc');

const TRPC_RUNTIME_FILES = [
  ...readdirSync(TRPC_ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.trpc.ts'))
    .map((entry) => relative(process.cwd(), join(entry.parentPath, entry.name))),
  'src/backend/trpc/workspace/workspace-helpers.ts',
].sort();

const ALLOWED_PURE_BACKEND_IMPORTS = new Map<string, ReadonlySet<string>>([
  ['@/backend/services/github', new Set(['classifyGitHubCLIError'])],
  ['@/backend/services/git-clone.service', new Set(['parseGithubUrl'])],
  [
    '@/backend/services/workspace',
    new Set([
      'computeKanbanColumn',
      'computePendingRequestType',
      'deriveWorkspaceFlowStateFromWorkspace',
      'getWorkspaceInitPolicy',
    ]),
  ],
]);

function isBackendRuntimeModule(moduleSpecifier: string): boolean {
  return /^@\/backend\/(?:services|orchestration|db)(?:\/|$)/.test(moduleSpecifier);
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

function findImportDeclarationViolations(statement: ts.ImportDeclaration): string[] {
  if (!ts.isStringLiteral(statement.moduleSpecifier)) {
    return [];
  }

  const moduleSpecifier = statement.moduleSpecifier.text;
  if (!isBackendRuntimeModule(moduleSpecifier)) {
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

function findForbiddenBackendImports(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'trpc-runtime-imports.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  return sourceFile.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) ? findImportDeclarationViolations(statement) : []
  );
}

describe('tRPC context dependencies', () => {
  it.each(TRPC_RUNTIME_FILES)('%s uses context runtime dependencies', (file) => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');

    expect(findForbiddenBackendImports(source), file).toEqual([]);
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
        '@/backend/services/git-clone.service#unknownRuntime',
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
        '@/backend/services/session#default',
        '@/backend/services/workspace#*',
        '@/backend/orchestration/reconciliation.service#side-effect',
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
