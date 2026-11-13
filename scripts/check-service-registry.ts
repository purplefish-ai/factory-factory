import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  infrastructureServiceRegistry,
  prismaModelNames,
  type ServiceDefinition,
  type ServiceName,
  serviceNames,
  serviceRegistry,
} from '../src/backend/services/registry';
import { getInfrastructureServiceClassificationErrors } from '../src/backend/services/service-registry-check.helpers';
import { sessionModuleCycles, sessionModules } from '../src/backend/services/session/modules';
import { resolveBaseRef } from './check-guidance';
import { getCapsuleBarrelWildcardErrors } from './service-registry-barrels';
import { collectBridgeEdges } from './service-registry-bridges';
import { getDeclaredDependencyErrors } from './service-registry-dependencies';
import {
  type BaseModulesSource,
  checkSessionModuleCyclesAgainstBase,
  sessionModulesFile,
} from './service-registry-session-cycles';
import {
  collectSessionModuleEdges,
  getSessionModuleErrors,
  isSessionTestFile,
  sessionModuleDirectories,
  sessionServiceRoot,
} from './service-registry-session-modules';

const rootDir = process.cwd();
const backendRoot = path.join(rootDir, 'src/backend');
const servicesRoot = path.join(rootDir, 'src/backend/services');
const declaredServices: Record<ServiceName, ServiceDefinition> = serviceRegistry;
// A cheap prefilter; the AST scanner decides what is actually a wiring call.
const bridgeWiringCallPattern = /\b(?:configure[A-Za-z]*|setHandler)\s*[<(]/u;
// `*.test-helpers.ts`, `*.test-support.ts`, `*.test-harness.ts` and test directories.
const testSupportPathPattern = /(?:^|\/)(?:testing|test-utils)\/|\.test-[a-z-]+\.tsx?$/u;
const schemaPath = path.join(rootDir, 'prisma/schema.prisma');
const prismaGeneratedRoot = path.join(rootDir, 'prisma/generated');
const publicPrismaGeneratedSpecifiers = new Set([
  '@prisma-gen/browser',
  '@prisma-gen/client',
  '@prisma-gen/commonInputTypes',
  '@prisma-gen/enums',
  '@prisma-gen/models',
]);
const infrastructureServiceNames = new Set(Object.keys(infrastructureServiceRegistry));

function readPrismaModelNames(schemaFilePath: string): Set<string> {
  const schema = readFileSync(schemaFilePath, 'utf8');
  const modelNameMatches = schema.matchAll(/^model\s+([A-Za-z_][A-Za-z0-9_]*)\s+\{/gm);
  const modelNames = new Set<string>();

  for (const match of modelNameMatches) {
    const modelName = match[1];
    if (modelName !== undefined) {
      modelNames.add(modelName);
    }
  }

  return modelNames;
}

function listTypeScriptFiles(dirPath: string, includeTests = false): string[] {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const filePaths: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      filePaths.push(...listTypeScriptFiles(entryPath, includeTests));
      continue;
    }

    if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      (includeTests || !(entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')))
    ) {
      filePaths.push(entryPath);
    }
  }

  return filePaths;
}

function collectModuleSpecifiers(filePath: string): string[] {
  const sourceText = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const moduleSpecifiers: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (
        moduleSpecifier &&
        ts.isStringLiteral(moduleSpecifier) &&
        moduleSpecifier.text.length > 0
      ) {
        moduleSpecifiers.push(moduleSpecifier.text);
      }
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [moduleSpecifier] = node.arguments;
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        moduleSpecifiers.push(moduleSpecifier.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return moduleSpecifiers;
}

function checkModelOwnership(schemaModelNames: Set<string>, errors: string[]): void {
  const ownersByModel = new Map<string, ServiceName[]>();

  for (const [serviceName, definition] of Object.entries(serviceRegistry) as [
    ServiceName,
    (typeof serviceRegistry)[ServiceName],
  ][]) {
    for (const modelName of definition.ownsModels) {
      if (!schemaModelNames.has(modelName)) {
        errors.push(`Service "${serviceName}" owns unknown Prisma model "${modelName}".`);
        continue;
      }

      const owners = ownersByModel.get(modelName) ?? [];
      owners.push(serviceName);
      ownersByModel.set(modelName, owners);
    }
  }

  for (const modelName of schemaModelNames) {
    const owners = ownersByModel.get(modelName) ?? [];
    if (owners.length === 0) {
      errors.push(`Prisma model "${modelName}" has no owning service.`);
      continue;
    }
    if (owners.length > 1) {
      errors.push(`Prisma model "${modelName}" has multiple owners: ${owners.join(', ')}.`);
    }
  }
}

function checkDependencyGraph(errors: string[]): void {
  const services = Object.keys(serviceRegistry) as ServiceName[];

  for (const serviceName of services) {
    for (const dependencyName of serviceRegistry[serviceName].dependsOn) {
      if (!services.includes(dependencyName)) {
        errors.push(`Service "${serviceName}" depends on unknown service "${dependencyName}".`);
      }
    }
  }

  const permanent = new Set<ServiceName>();
  const temporary = new Set<ServiceName>();

  const visit = (serviceName: ServiceName, stack: ServiceName[]) => {
    if (temporary.has(serviceName)) {
      const cycleStart = stack.indexOf(serviceName);
      const cycle = [...stack.slice(cycleStart), serviceName];
      errors.push(`Service dependency cycle detected: ${cycle.join(' -> ')}`);
      return;
    }

    if (permanent.has(serviceName)) {
      return;
    }

    temporary.add(serviceName);
    for (const dependency of serviceRegistry[serviceName].dependsOn) {
      visit(dependency, [...stack, serviceName]);
    }
    temporary.delete(serviceName);
    permanent.add(serviceName);
  };

  for (const serviceName of services) {
    visit(serviceName, []);
  }
}

function getRelativeServiceFilePath(filePath: string): string {
  return path.relative(rootDir, filePath).replaceAll('\\', '/');
}

function isRegisteredServiceName(serviceName: string): serviceName is ServiceName {
  return Object.hasOwn(serviceRegistry, serviceName);
}

function checkInfrastructureServiceClassification(errors: string[]): void {
  errors.push(
    ...getInfrastructureServiceClassificationErrors(servicesRoot, infrastructureServiceRegistry)
  );
}

function getFromService(relativePath: string): ServiceName | null {
  const fromMatch = relativePath.match(/^src\/backend\/services\/([^/]+)\//);
  if (!fromMatch) {
    return null;
  }

  const serviceName = fromMatch[1];
  if (serviceName === undefined) {
    return null;
  }
  if (!isRegisteredServiceName(serviceName)) {
    return null;
  }

  return serviceName;
}

function parseServiceImport(
  moduleSpecifier: string
): { toServiceName: string; toSubpath: string } | null {
  const toMatch = moduleSpecifier.match(/^@\/backend\/services\/([^/]+)(?:\/(.*))?$/);
  if (!toMatch) {
    return null;
  }
  const toServiceName = toMatch[1];
  if (toServiceName === undefined) {
    return null;
  }

  return {
    toServiceName,
    toSubpath: toMatch[2] ?? '',
  };
}

function validateCrossServiceImport(
  fromService: ServiceName,
  relativePath: string,
  moduleSpecifier: string,
  allowedDependencies: Set<ServiceName>,
  importedDependencies: Set<ServiceName>,
  errors: string[]
): void {
  const serviceImport = parseServiceImport(moduleSpecifier);
  if (!serviceImport) {
    return;
  }

  if (!isRegisteredServiceName(serviceImport.toServiceName)) {
    if (infrastructureServiceNames.has(serviceImport.toServiceName)) {
      return;
    }
    errors.push(
      `${relativePath} imports unknown service "${serviceImport.toServiceName}" via "${moduleSpecifier}". Add it to src/backend/services/registry.ts or fix the import.`
    );
    return;
  }

  const toService = serviceImport.toServiceName;
  if (toService === fromService) {
    return;
  }
  importedDependencies.add(toService);

  if (serviceImport.toSubpath.length > 0 && serviceImport.toSubpath !== 'index') {
    errors.push(
      `${relativePath} imports "${moduleSpecifier}", but cross-service imports must target only "@/backend/services/<service>".`
    );
  }

  if (!allowedDependencies.has(toService)) {
    errors.push(
      `${relativePath} imports service "${toService}" but "${fromService}" does not declare it in dependsOn.`
    );
  }
}

function importedSetFor(
  importedDependencies: Map<ServiceName, Set<ServiceName>>,
  serviceName: ServiceName
): Set<ServiceName> {
  const imported = importedDependencies.get(serviceName) ?? new Set<ServiceName>();
  importedDependencies.set(serviceName, imported);
  return imported;
}

/** Validates cross-capsule imports and returns the capsules each capsule imports. */
function checkCrossServiceImports(errors: string[]): Map<ServiceName, Set<ServiceName>> {
  const serviceFiles = listTypeScriptFiles(servicesRoot);
  const importedDependencies = new Map<ServiceName, Set<ServiceName>>();

  for (const filePath of serviceFiles) {
    const relativePath = getRelativeServiceFilePath(filePath);
    if (relativePath === 'src/backend/services/registry.ts') {
      continue;
    }

    const rawMatch = relativePath.match(/^src\/backend\/services\/([^/]+)\//);
    if (!rawMatch) {
      continue;
    }
    const rawServiceDirectory = rawMatch[1];
    if (rawServiceDirectory === undefined) {
      continue;
    }

    if (!isRegisteredServiceName(rawServiceDirectory)) {
      errors.push(
        `${relativePath} is under unregistered service directory "${rawServiceDirectory}". Add it to src/backend/services/registry.ts.`
      );
      continue;
    }

    const fromService = getFromService(relativePath);
    if (!fromService) {
      continue;
    }
    const allowedDependencies = new Set(serviceRegistry[fromService].dependsOn);
    // Test support still obeys the import allowlist, but cannot keep a
    // production dependency declaration alive.
    const imported = testSupportPathPattern.test(relativePath)
      ? new Set<ServiceName>()
      : importedSetFor(importedDependencies, fromService);

    for (const moduleSpecifier of collectModuleSpecifiers(filePath)) {
      validateCrossServiceImport(
        fromService,
        relativePath,
        moduleSpecifier,
        allowedDependencies,
        imported,
        errors
      );
    }
  }

  return importedDependencies;
}

/** Production files outside the capsules that may wire bridges between them. */
function listBridgeWiringFiles(): string[] {
  return listTypeScriptFiles(backendRoot).filter((filePath) => {
    const relativePath = getRelativeServiceFilePath(filePath);
    return (
      !(isInsideDirectory(filePath, servicesRoot) || testSupportPathPattern.test(relativePath)) &&
      bridgeWiringCallPattern.test(readFileSync(filePath, 'utf8'))
    );
  });
}

function checkDeclaredDependencies(
  importedDependencies: Map<ServiceName, Set<ServiceName>>,
  errors: string[]
): void {
  const bridgeEdges = collectBridgeEdges({
    repositoryRoot: rootDir,
    wiringFiles: listBridgeWiringFiles(),
    serviceNames: new Set(serviceNames),
  });
  errors.push(
    ...getDeclaredDependencyErrors({
      registry: declaredServices,
      importedDependencies,
      bridgeEdges,
    })
  );
}

function isInsideDirectory(filePath: string, directoryPath: string): boolean {
  const relativePath = path.relative(directoryPath, filePath);
  return (
    relativePath.length === 0 || !(relativePath.startsWith('..') || path.isAbsolute(relativePath))
  );
}

function checkPrismaGeneratedImport(
  filePath: string,
  relativePath: string,
  moduleSpecifier: string,
  errors: string[]
): void {
  if (moduleSpecifier.startsWith('@prisma-gen/')) {
    if (!publicPrismaGeneratedSpecifiers.has(moduleSpecifier)) {
      errors.push(
        `${relativePath} imports "${moduleSpecifier}", but generated Prisma imports must use public @prisma-gen entrypoints: ${Array.from(publicPrismaGeneratedSpecifiers).join(', ')}.`
      );
    }
    return;
  }

  if (moduleSpecifier === 'prisma/generated' || moduleSpecifier.startsWith('prisma/generated/')) {
    errors.push(
      `${relativePath} imports "${moduleSpecifier}" directly. Use a public @prisma-gen/* entrypoint instead.`
    );
    return;
  }

  if (!moduleSpecifier.startsWith('.')) {
    return;
  }

  const resolvedImportPath = path.resolve(path.dirname(filePath), moduleSpecifier);
  if (isInsideDirectory(resolvedImportPath, prismaGeneratedRoot)) {
    errors.push(
      `${relativePath} imports "${moduleSpecifier}" from prisma/generated directly. Use a public @prisma-gen/* entrypoint instead.`
    );
  }
}

function checkPrismaGeneratedImports(errors: string[]): void {
  const codeRoots = ['src', 'scripts', 'electron'];

  for (const codeRoot of codeRoots) {
    const absoluteCodeRoot = path.join(rootDir, codeRoot);
    if (!existsSync(absoluteCodeRoot)) {
      continue;
    }

    for (const filePath of listTypeScriptFiles(absoluteCodeRoot, true)) {
      if (isInsideDirectory(filePath, prismaGeneratedRoot)) {
        continue;
      }

      const relativePath = getRelativeServiceFilePath(filePath);
      for (const moduleSpecifier of collectModuleSpecifiers(filePath)) {
        checkPrismaGeneratedImport(filePath, relativePath, moduleSpecifier, errors);
      }
    }
  }
}

function checkRegistryModelList(errors: string[]): void {
  const schemaModelNames = readPrismaModelNames(schemaPath);

  for (const modelName of prismaModelNames) {
    if (!schemaModelNames.has(modelName)) {
      errors.push(
        `Model "${modelName}" is listed in prismaModelNames but missing from prisma/schema.prisma.`
      );
    }
  }

  for (const modelName of schemaModelNames) {
    if (!(prismaModelNames as readonly string[]).includes(modelName)) {
      errors.push(
        `Model "${modelName}" exists in prisma/schema.prisma but is missing from prismaModelNames.`
      );
    }
  }

  checkModelOwnership(schemaModelNames, errors);
}

/** Capsule barrels must list their public names; see service-registry-barrels.ts. */
function checkCapsuleBarrels(errors: string[]): void {
  const barrels = readdirSync(servicesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      ['index.ts', 'index.tsx']
        .map((fileName) => path.join(servicesRoot, entry.name, fileName))
        .filter((filePath) => existsSync(filePath))
    )
    .map((filePath) => ({
      path: getRelativeServiceFilePath(filePath),
      source: readFileSync(filePath, 'utf8'),
    }));
  errors.push(...getCapsuleBarrelWildcardErrors(barrels));
}

/** The session capsule's module map must match its imports; see service-registry-session-modules.ts. */
function checkSessionModules(errors: string[], reportUnneededBackEdges: boolean): void {
  const filePaths = listTypeScriptFiles(path.join(rootDir, sessionServiceRoot), true).map(
    (filePath) => ({ filePath, path: getRelativeServiceFilePath(filePath) })
  );
  const moduleDirectories = sessionModuleDirectories(filePaths.map((file) => file.path));
  const files = filePaths
    .filter((file) => !isSessionTestFile(file.path))
    .map((file) => ({ path: file.path, source: readFileSync(file.filePath, 'utf8') }));
  errors.push(
    ...getSessionModuleErrors({
      modules: sessionModules,
      cycles: sessionModuleCycles,
      moduleDirectories,
      edges: collectSessionModuleEdges(files, moduleDirectories),
      reportUnneededBackEdges,
    })
  );
}

function showAtRevision(revision: string): string | undefined {
  try {
    return execFileSync('git', ['show', revision], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

/** The base branch's `modules.ts`, found the way `pnpm check:guidance` finds its base. */
function readBaseModulesSource(): BaseModulesSource {
  const ref = resolveBaseRef(rootDir);
  if (ref === undefined) {
    return { kind: 'no-ref' };
  }
  const source = showAtRevision(`${ref}:${sessionModulesFile}`);
  return source === undefined ? { kind: 'absent', ref } : { kind: 'present', ref, source };
}

function main(): void {
  const errors: string[] = [];

  checkInfrastructureServiceClassification(errors);
  checkRegistryModelList(errors);
  checkDependencyGraph(errors);
  checkDeclaredDependencies(checkCrossServiceImports(errors), errors);
  checkPrismaGeneratedImports(errors);
  checkCapsuleBarrels(errors);
  // sessionModuleCycles may lose entries but never gain one.
  const cyclesAgainstBase = checkSessionModuleCyclesAgainstBase({
    currentSource: readFileSync(path.join(rootDir, sessionModulesFile), 'utf8'),
    imported: sessionModuleCycles,
    base: readBaseModulesSource(),
  });
  errors.push(...cyclesAgainstBase.errors);
  checkSessionModules(errors, !cyclesAgainstBase.added);
  if (cyclesAgainstBase.notice !== undefined) {
    process.stdout.write(`Service registry check: ${cyclesAgainstBase.notice}\n`);
  }

  if (errors.length > 0) {
    const output = [
      'Service registry check failed:',
      ...errors.map((error) => `- ${error}`),
      '',
    ].join('\n');
    process.stderr.write(output);
    process.exit(1);
  }

  process.stdout.write('Service registry check passed.\n');
}

main();
