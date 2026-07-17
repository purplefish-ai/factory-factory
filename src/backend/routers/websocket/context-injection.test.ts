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

const WEBSOCKET_ROOT = resolve(REPOSITORY_ROOT, 'src/backend/routers/websocket');

function discoverProductionWebSocketFiles(): string[] {
  return discoverProductionTypeScriptFiles(WEBSOCKET_ROOT);
}

const TRANSPORT_FILES = [
  'src/backend/server.ts',
  'src/backend/routers/health.router.ts',
  ...discoverProductionWebSocketFiles(),
];

const ALLOWED_PURE_RUNTIME_IMPORTS = new Map<string, ReadonlySet<string>>([
  ['src/backend/services/session', new Set(['CHAT_BROADCAST_EVENT', 'SESSION_OUTBOUND_EVENT'])],
  ['src/backend/services/workspace', new Set(['SNAPSHOT_CHANGED', 'SNAPSHOT_REMOVED'])],
]);

const LONG_LIVED_BACKEND_ROOT_MODULES = new Set([
  'src/backend/app-context',
  'src/backend/db',
  'src/backend/fatal-error-handlers',
  'src/backend/interceptors',
  'src/backend/migrate',
  'src/backend/server',
]);

const APPLICATION_FACTORY_MODULES = new Set(['src/backend/app-context', 'src/backend/server']);
const APPLICATION_FACTORY_EXPORTS = new Set(['createApplication', 'createAppContext']);

type BoundaryViolation = {
  readonly kind: 'composition' | 'import';
  readonly detail: string;
};

type ImportTracking = {
  readonly applicationFactoryBindings: Set<string>;
  readonly applicationFactoryNamespaces: Set<string>;
  readonly restrictedBindings: Set<string>;
};

function resolveBackendModule(importer: string, moduleSpecifier: string): string | null {
  const repositoryPath = resolveRepositoryModule(importer, moduleSpecifier);
  if (!repositoryPath) {
    return null;
  }
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

function trackFactoryModuleBinding(
  modulePath: string,
  binding: string,
  tracking: ImportTracking,
  directFactory: boolean
): void {
  if (!APPLICATION_FACTORY_MODULES.has(modulePath)) {
    return;
  }
  tracking.applicationFactoryNamespaces.add(binding);
  if (directFactory) {
    tracking.applicationFactoryBindings.add(binding);
  }
}

function classifyNamedRuntimeImports(
  modulePath: string,
  namedImports: ts.NamedImports,
  tracking: ImportTracking
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const allowedBindings = ALLOWED_PURE_RUNTIME_IMPORTS.get(modulePath);
  for (const element of namedImports.elements) {
    if (element.isTypeOnly) {
      continue;
    }
    const importedName = element.propertyName?.text ?? element.name.text;
    if (!allowedBindings?.has(importedName)) {
      tracking.restrictedBindings.add(element.name.text);
      if (
        APPLICATION_FACTORY_MODULES.has(modulePath) &&
        APPLICATION_FACTORY_EXPORTS.has(importedName)
      ) {
        tracking.applicationFactoryBindings.add(element.name.text);
      }
      violations.push(importViolation(modulePath, importedName));
    }
  }
  return violations;
}

function classifyRuntimeImport(
  modulePath: string,
  importClause: ts.ImportClause | undefined,
  tracking: ImportTracking
): BoundaryViolation[] {
  if (!importClause) {
    return [importViolation(modulePath, 'side-effect')];
  }
  if (importClause.isTypeOnly) {
    return [];
  }

  const violations: BoundaryViolation[] = [];
  if (importClause.name) {
    tracking.restrictedBindings.add(importClause.name.text);
    trackFactoryModuleBinding(modulePath, importClause.name.text, tracking, true);
    violations.push(importViolation(modulePath, 'default'));
  }

  const namedBindings = importClause.namedBindings;
  if (!namedBindings) {
    return violations;
  }
  if (ts.isNamespaceImport(namedBindings)) {
    tracking.restrictedBindings.add(namedBindings.name.text);
    trackFactoryModuleBinding(modulePath, namedBindings.name.text, tracking, false);
    violations.push(importViolation(modulePath, '*'));
    return violations;
  }

  violations.push(...classifyNamedRuntimeImports(modulePath, namedBindings, tracking));
  return violations;
}

function findImportViolations(
  importer: string,
  importDeclarations: readonly ts.ImportDeclaration[],
  tracking: ImportTracking
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const statement of importDeclarations) {
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const modulePath = resolveBackendModule(importer, statement.moduleSpecifier.text);
    if (!(modulePath && isLongLivedRuntimeModule(modulePath))) {
      continue;
    }
    violations.push(...classifyRuntimeImport(modulePath, statement.importClause, tracking));
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

function accessedMemberName(expression: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteral(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return null;
}

function accessedReceiver(expression: ts.Expression): ts.Expression | null {
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? expression.expression
    : null;
}

function collectDomainWiringBindings(
  declaration: ts.VariableDeclaration,
  graphBindings: ReadonlySet<string>,
  domainWiringBindings: Set<string>
): void {
  const initializer = declaration.initializer;
  if (!initializer) {
    return;
  }

  if (
    ts.isIdentifier(declaration.name) &&
    accessedMemberName(initializer) === 'wireDomainBridges'
  ) {
    const receiver = accessedReceiver(initializer);
    if (receiver && isGraphExpression(receiver, graphBindings)) {
      domainWiringBindings.add(declaration.name.text);
    }
  }

  if (
    !(ts.isObjectBindingPattern(declaration.name) && isGraphExpression(initializer, graphBindings))
  ) {
    return;
  }
  for (const element of declaration.name.elements) {
    const selectedName = element.propertyName?.getText() ?? element.name.getText();
    if (selectedName === 'wireDomainBridges') {
      collectBindingNames(element.name, domainWiringBindings);
    }
  }
}

function collectApplicationFactoryBindings(
  declaration: ts.VariableDeclaration,
  tracking: ImportTracking
): void {
  const initializer = declaration.initializer;
  if (!initializer) {
    return;
  }

  if (ts.isIdentifier(initializer) && tracking.applicationFactoryBindings.has(initializer.text)) {
    collectBindingNames(declaration.name, tracking.applicationFactoryBindings);
    return;
  }

  const factoryName = accessedMemberName(initializer);
  const receiver = accessedReceiver(initializer);
  const root = receiver ? expressionPath(receiver)?.[0] : undefined;
  if (
    factoryName &&
    APPLICATION_FACTORY_EXPORTS.has(factoryName) &&
    root &&
    tracking.applicationFactoryNamespaces.has(root)
  ) {
    collectBindingNames(declaration.name, tracking.applicationFactoryBindings);
    return;
  }

  if (
    !(
      ts.isObjectBindingPattern(declaration.name) &&
      ts.isIdentifier(initializer) &&
      tracking.applicationFactoryNamespaces.has(initializer.text)
    )
  ) {
    return;
  }
  for (const element of declaration.name.elements) {
    const selectedName = element.propertyName?.getText() ?? element.name.getText();
    if (APPLICATION_FACTORY_EXPORTS.has(selectedName)) {
      collectBindingNames(element.name, tracking.applicationFactoryBindings);
    }
  }
}

function applicationFactoryViolationForCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  tracking: ImportTracking
): BoundaryViolation | null {
  if (
    ts.isIdentifier(node.expression) &&
    tracking.applicationFactoryBindings.has(node.expression.text)
  ) {
    return { kind: 'composition', detail: `${node.expression.getText(sourceFile)}()` };
  }

  const factoryName = accessedMemberName(node.expression);
  const receiver = accessedReceiver(node.expression);
  const root = receiver ? expressionPath(receiver)?.[0] : undefined;
  if (
    factoryName &&
    APPLICATION_FACTORY_EXPORTS.has(factoryName) &&
    root &&
    tracking.applicationFactoryNamespaces.has(root)
  ) {
    return { kind: 'composition', detail: `${node.expression.getText(sourceFile)}()` };
  }
  return null;
}

function compositionViolationForCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  graphBindings: ReadonlySet<string>,
  domainWiringBindings: ReadonlySet<string>,
  tracking: ImportTracking
): BoundaryViolation | null {
  const applicationFactoryViolation = applicationFactoryViolationForCall(
    node,
    sourceFile,
    tracking
  );
  if (applicationFactoryViolation) {
    return applicationFactoryViolation;
  }

  if (ts.isIdentifier(node.expression) && domainWiringBindings.has(node.expression.text)) {
    return { kind: 'composition', detail: node.expression.getText(sourceFile) };
  }

  const calledMember = accessedMemberName(node.expression);
  const receiver = accessedReceiver(node.expression);
  if (!receiver) {
    return null;
  }
  if (calledMember === 'wireDomainBridges' && isGraphExpression(receiver, graphBindings)) {
    return { kind: 'composition', detail: node.expression.getText(sourceFile) };
  }
  if (calledMember !== 'configure') {
    return null;
  }
  const root = expressionPath(receiver)?.[0];
  if (
    !(isGraphExpression(receiver, graphBindings) || (root && tracking.restrictedBindings.has(root)))
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
  tracking: ImportTracking
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const domainWiringBindings = new Set<string>();
  const graphBindings = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      collectApplicationFactoryBindings(node, tracking);
      collectDomainWiringBindings(node, graphBindings, domainWiringBindings);
      if (variableSelectsGraph(node, graphBindings)) {
        collectBindingNames(node.name, graphBindings);
      }
    }

    if (ts.isCallExpression(node)) {
      const violation = compositionViolationForCall(
        node,
        sourceFile,
        graphBindings,
        domainWiringBindings,
        tracking
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
  const { importDeclarations, sourceFile } = parseTypeScriptImports(source, importer);
  const tracking: ImportTracking = {
    applicationFactoryBindings: new Set(),
    applicationFactoryNamespaces: new Set(),
    restrictedBindings: new Set(),
  };

  return [
    ...findImportViolations(importer, importDeclarations, tracking),
    ...findCompositionViolations(sourceFile, tracking),
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
            import { SNAPSHOT_CHANGED } from '@/backend/services/workspace';
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

    it('rejects application construction through the server re-export', () => {
      expect(
        findBoundaryViolations(
          'src/backend/routers/websocket/new.handler.ts',
          `
            import { createApplication } from '@/backend/server';
            const application = createApplication();
          `
        )
      ).toEqual([
        importViolation('src/backend/server', 'createApplication'),
        { kind: 'composition', detail: 'createApplication()' },
      ]);
    });

    it('rejects an aliased application factory imported through a relative server path', () => {
      expect(
        findBoundaryViolations(
          'src/backend/routers/websocket/new.handler.ts',
          `
            import { createApplication as buildApplication } from '../../server';
            const application = buildApplication();
          `
        )
      ).toEqual([
        importViolation('src/backend/server', 'createApplication'),
        { kind: 'composition', detail: 'buildApplication()' },
      ]);
    });

    it('rejects application construction through namespace and default server imports', () => {
      expect(
        findBoundaryViolations(
          'src/backend/routers/websocket/new.handler.ts',
          `
            import serverFactory from '../../server';
            import * as serverModule from '../../server';
            const { createApplication: buildFromServer } = serverModule;
            serverFactory();
            serverModule.createApplication();
            buildFromServer();
          `
        )
      ).toEqual([
        importViolation('src/backend/server', 'default'),
        importViolation('src/backend/server', '*'),
        { kind: 'composition', detail: 'serverFactory()' },
        { kind: 'composition', detail: 'serverModule.createApplication()' },
        { kind: 'composition', detail: 'buildFromServer()' },
      ]);
    });

    it('rejects direct bridge wiring through graph-derived lifecycle and services', () => {
      expect(
        findBoundaryViolations(
          'src/backend/routers/websocket/new.handler.ts',
          `
            function wire(application: Application) {
              const { lifecycle, services } = application;
              lifecycle.wireDomainBridges(services);
            }
          `
        )
      ).toEqual([{ kind: 'composition', detail: 'lifecycle.wireDomainBridges' }]);
    });

    it('rejects graph-derived bridge wiring through lifecycle and method aliases', () => {
      expect(
        findBoundaryViolations(
          'src/backend/routers/websocket/new.handler.ts',
          `
            function wire(runtimeGraph: Application) {
              const { lifecycle: runtimeLifecycle, services: runtimeServices } = runtimeGraph;
              runtimeLifecycle.wireDomainBridges(runtimeServices);
              const { wireDomainBridges: wireBridges } = runtimeLifecycle;
              wireBridges(runtimeServices);
            }
          `
        )
      ).toEqual([
        { kind: 'composition', detail: 'runtimeLifecycle.wireDomainBridges' },
        { kind: 'composition', detail: 'wireBridges' },
      ]);
    });
  });

  it('websocket barrel does not export context-owning upgrade handler instances', () => {
    const source = readFileSync(resolve(WEBSOCKET_ROOT, 'index.ts'), 'utf8');

    expect(source).not.toMatch(
      /handle(Chat|Terminal|DevLogs|PostRunLogs|SetupTerminal|Snapshots)Upgrade/
    );
  });
});
