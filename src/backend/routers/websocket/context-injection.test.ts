import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = process.cwd();
const WEBSOCKET_ROOT = resolve(REPOSITORY_ROOT, 'src/backend/routers/websocket');

function isProductionTypeScriptFile(fileName: string): boolean {
  return (
    fileName.endsWith('.ts') &&
    !fileName.endsWith('.test.ts') &&
    !fileName.endsWith('.spec.ts') &&
    !fileName.endsWith('.d.ts')
  );
}

function discoverProductionWebSocketFiles(): string[] {
  return readdirSync(WEBSOCKET_ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && isProductionTypeScriptFile(entry.name))
    .map((entry) => relative(REPOSITORY_ROOT, join(entry.parentPath, entry.name)))
    .sort();
}

const TRANSPORT_FILES = [
  'src/backend/server.ts',
  'src/backend/routers/health.router.ts',
  ...discoverProductionWebSocketFiles(),
];

const ALLOWED_PURE_RUNTIME_IMPORTS = new Map<string, ReadonlySet<string>>([
  ['src/backend/services/session', new Set(['CHAT_BROADCAST_EVENT', 'SESSION_OUTBOUND_EVENT'])],
  [
    'src/backend/services/workspace-snapshot-store.service',
    new Set(['SNAPSHOT_CHANGED', 'SNAPSHOT_REMOVED']),
  ],
]);

const LONG_LIVED_BACKEND_ROOT_MODULES = new Set([
  'src/backend/app-context',
  'src/backend/db',
  'src/backend/fatal-error-handlers',
  'src/backend/interceptors',
  'src/backend/migrate',
]);

type BoundaryViolation = {
  readonly kind: 'composition' | 'import';
  readonly detail: string;
};

function normalizeRepositoryPath(path: string): string {
  return path
    .split(sep)
    .join('/')
    .replace(/\.(?:[cm]?ts|[cm]?js)x?$/, '');
}

function resolveBackendModule(importer: string, moduleSpecifier: string): string | null {
  let absolutePath: string;
  if (moduleSpecifier.startsWith('@/')) {
    absolutePath = resolve(REPOSITORY_ROOT, 'src', moduleSpecifier.slice(2));
  } else if (moduleSpecifier.startsWith('.')) {
    absolutePath = resolve(dirname(resolve(REPOSITORY_ROOT, importer)), moduleSpecifier);
  } else if (isAbsolute(moduleSpecifier)) {
    absolutePath = moduleSpecifier;
  } else {
    return null;
  }

  const repositoryPath = normalizeRepositoryPath(relative(REPOSITORY_ROOT, absolutePath));
  return repositoryPath.startsWith('src/backend/') ? repositoryPath : null;
}

function isLongLivedRuntimeModule(repositoryPath: string): boolean {
  return (
    LONG_LIVED_BACKEND_ROOT_MODULES.has(repositoryPath) ||
    repositoryPath.startsWith('src/backend/interceptors/') ||
    repositoryPath === 'src/backend/orchestration' ||
    repositoryPath.startsWith('src/backend/orchestration/') ||
    repositoryPath === 'src/backend/services' ||
    repositoryPath.startsWith('src/backend/services/')
  );
}

function importViolation(modulePath: string, binding: string): BoundaryViolation {
  return { kind: 'import', detail: `${modulePath}#${binding}` };
}

function collectBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      collectBindingNames(element.name, names);
    }
  }
}

function expressionPath(expression: ts.Expression): string[] | null {
  if (ts.isIdentifier(expression)) {
    return [expression.text];
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = expressionPath(expression.expression);
    return parent ? [...parent, expression.name.text] : null;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteral(expression.argumentExpression)
  ) {
    const parent = expressionPath(expression.expression);
    return parent ? [...parent, expression.argumentExpression.text] : null;
  }
  return null;
}

function isGraphExpression(expression: ts.Expression, graphBindings: ReadonlySet<string>): boolean {
  const path = expressionPath(expression);
  if (!path || path.length === 0) {
    return false;
  }
  const root = path[0];
  if (!root) {
    return false;
  }
  if (graphBindings.has(root)) {
    return true;
  }
  return path.some((part) => part === 'services' || part === 'lifecycle');
}

function bindingSelectsGraphSection(name: ts.BindingName): boolean {
  if (!ts.isObjectBindingPattern(name)) {
    return false;
  }
  return name.elements.some((element) => {
    const selectedName = element.propertyName?.getText() ?? element.name.getText();
    return selectedName === 'services' || selectedName === 'lifecycle';
  });
}

function classifyRuntimeImport(
  modulePath: string,
  importClause: ts.ImportClause | undefined,
  restrictedImportBindings: Set<string>
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  if (!importClause) {
    return [importViolation(modulePath, 'side-effect')];
  }
  if (importClause.isTypeOnly) {
    return violations;
  }

  if (importClause.name) {
    restrictedImportBindings.add(importClause.name.text);
    violations.push(importViolation(modulePath, 'default'));
  }

  const namedBindings = importClause.namedBindings;
  if (!namedBindings) {
    return violations;
  }
  if (ts.isNamespaceImport(namedBindings)) {
    restrictedImportBindings.add(namedBindings.name.text);
    violations.push(importViolation(modulePath, '*'));
    return violations;
  }

  const allowedBindings = ALLOWED_PURE_RUNTIME_IMPORTS.get(modulePath);
  for (const element of namedBindings.elements) {
    if (element.isTypeOnly) {
      continue;
    }
    const importedName = element.propertyName?.text ?? element.name.text;
    if (!allowedBindings?.has(importedName)) {
      restrictedImportBindings.add(element.name.text);
      violations.push(importViolation(modulePath, importedName));
    }
  }
  return violations;
}

function findImportViolations(
  importer: string,
  sourceFile: ts.SourceFile,
  restrictedImportBindings: Set<string>
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const statement of sourceFile.statements) {
    if (!(ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))) {
      continue;
    }
    const modulePath = resolveBackendModule(importer, statement.moduleSpecifier.text);
    if (!(modulePath && isLongLivedRuntimeModule(modulePath))) {
      continue;
    }
    violations.push(
      ...classifyRuntimeImport(modulePath, statement.importClause, restrictedImportBindings)
    );
  }
  return violations;
}

function variableSelectsGraph(
  declaration: ts.VariableDeclaration,
  graphBindings: ReadonlySet<string>
): boolean {
  const initializer = declaration.initializer;
  if (!initializer) {
    return false;
  }
  return (
    isGraphExpression(initializer, graphBindings) ||
    (ts.isIdentifier(initializer) && bindingSelectsGraphSection(declaration.name))
  );
}

function compositionViolationForCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  graphBindings: ReadonlySet<string>,
  restrictedImportBindings: ReadonlySet<string>
): BoundaryViolation | null {
  if (
    !(ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'configure')
  ) {
    return null;
  }
  const receiver = node.expression.expression;
  const root = expressionPath(receiver)?.[0];
  if (
    !(isGraphExpression(receiver, graphBindings) || (root && restrictedImportBindings.has(root)))
  ) {
    return null;
  }
  return {
    kind: 'composition',
    detail: `${receiver.getText(sourceFile)}.configure`,
  };
}

function findCompositionViolations(
  sourceFile: ts.SourceFile,
  restrictedImportBindings: ReadonlySet<string>
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const graphBindings = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && variableSelectsGraph(node, graphBindings)) {
      collectBindingNames(node.name, graphBindings);
    }

    if (ts.isCallExpression(node)) {
      const violation = compositionViolationForCall(
        node,
        sourceFile,
        graphBindings,
        restrictedImportBindings
      );
      if (violation) {
        violations.push(violation);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return violations;
}

function findBoundaryViolations(importer: string, source: string): BoundaryViolation[] {
  const sourceFile = ts.createSourceFile(
    importer,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const restrictedImportBindings = new Set<string>();

  return [
    ...findImportViolations(importer, sourceFile, restrictedImportBindings),
    ...findCompositionViolations(sourceFile, restrictedImportBindings),
  ];
}

describe('HTTP and WebSocket application context injection', () => {
  it('discovers every production WebSocket source instead of maintaining a handler list', () => {
    expect(TRANSPORT_FILES).toEqual(
      expect.arrayContaining([
        'src/backend/routers/websocket/index.ts',
        'src/backend/routers/websocket/message-utils.ts',
        'src/backend/routers/websocket/push-channel.handler.ts',
        'src/backend/routers/websocket/upgrade-utils.ts',
      ])
    );
    expect(TRANSPORT_FILES.some((file) => file.endsWith('.test.ts'))).toBe(false);
  });

  it.each(
    TRANSPORT_FILES
  )('%s resolves runtime dependencies through the application graph', (file) => {
    const source = readFileSync(resolve(REPOSITORY_ROOT, file), 'utf8');

    expect(findBoundaryViolations(file, source), file).toEqual([]);
  });

  describe('boundary classification', () => {
    it('rejects Prisma and interceptor lifecycle imports through relative paths', () => {
      const violations = findBoundaryViolations(
        'src/backend/server.ts',
        `
          import { prisma } from './db';
          import { registerInterceptors } from './interceptors';
        `
      );

      expect(violations).toEqual([
        importViolation('src/backend/db', 'prisma'),
        importViolation('src/backend/interceptors', 'registerInterceptors'),
      ]);
    });

    it('rejects unknown named singleton imports without relying on a binding blacklist', () => {
      expect(
        findBoundaryViolations(
          'src/backend/routers/websocket/new.handler.ts',
          `import { futureGlobalRuntime } from '@/backend/services/future-runtime.service';`
        )
      ).toEqual([
        importViolation('src/backend/services/future-runtime.service', 'futureGlobalRuntime'),
      ]);
    });

    it('rejects namespace, default, side-effect, and absolute runtime imports', () => {
      const absoluteDatabasePath = resolve(REPOSITORY_ROOT, 'src/backend/db.ts');

      expect(
        findBoundaryViolations(
          'src/backend/routers/websocket/new.handler.ts',
          `
            import runtimeDefault from '@/backend/services/session';
            import * as orchestration from '@/backend/orchestration/reconciliation.service';
            import '@/backend/services/rate-limiter.service';
            import database from '${absoluteDatabasePath}';
          `
        )
      ).toEqual([
        importViolation('src/backend/services/session', 'default'),
        importViolation('src/backend/orchestration/reconciliation.service', '*'),
        importViolation('src/backend/services/rate-limiter.service', 'side-effect'),
        importViolation('src/backend/db', 'default'),
      ]);
    });

    it('allows type imports and explicitly approved pure runtime constants', () => {
      expect(
        findBoundaryViolations(
          'src/backend/routers/websocket/new.handler.ts',
          `
            import type { AppContext } from '@/backend/app-context';
            import {
              CHAT_BROADCAST_EVENT,
              type SessionOutboundEvent,
            } from '@/backend/services/session';
            import { SNAPSHOT_CHANGED } from '@/backend/services/workspace-snapshot-store.service';
          `
        )
      ).toEqual([]);
    });

    it('rejects configure calls on graph and imported runtime services', () => {
      const violations = findBoundaryViolations(
        'src/backend/routers/websocket/new.handler.ts',
        `
          import { hiddenRuntime } from '@/backend/services/future-runtime.service';
          function wire(runtimeGraph: Application) {
            const { lifecycle } = runtimeGraph;
            const { snapshotReconciliation } = lifecycle;
            snapshotReconciliation.configure({});
            runtimeGraph.services.eventCollector.configure({});
            hiddenRuntime.configure({});
          }
        `
      );

      expect(violations).toEqual([
        importViolation('src/backend/services/future-runtime.service', 'hiddenRuntime'),
        { kind: 'composition', detail: 'snapshotReconciliation.configure' },
        { kind: 'composition', detail: 'runtimeGraph.services.eventCollector.configure' },
        { kind: 'composition', detail: 'hiddenRuntime.configure' },
      ]);
    });

    it('does not mistake configuration of a pure helper for application composition', () => {
      expect(
        findBoundaryViolations(
          'src/backend/routers/websocket/new.handler.ts',
          `
            import { formatter } from '@/backend/lib/formatter';
            formatter.configure({ lineWidth: 100 });
          `
        )
      ).toEqual([]);
    });
  });

  it('websocket barrel does not export context-owning upgrade handler instances', () => {
    const source = readFileSync(resolve(WEBSOCKET_ROOT, 'index.ts'), 'utf8');

    expect(source).not.toMatch(
      /handle(Chat|Terminal|DevLogs|PostRunLogs|SetupTerminal|Snapshots)Upgrade/
    );
  });
});
