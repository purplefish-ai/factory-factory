import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import {
  prismaModelNames,
  type ServiceName,
  serviceRegistry,
} from '../src/backend/services/registry';

const rootDir = process.cwd();
const servicesRoot = path.join(rootDir, 'src/backend/services');
const schemaPath = path.join(rootDir, 'prisma/schema.prisma');
const infraServiceFileNames = new Set(
  readdirSync(servicesRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
    )
    .map((entry) => entry.name.replace(/\.(ts|tsx)$/u, ''))
);

function readPrismaModelNames(schemaFilePath: string): Set<string> {
  const schema = readFileSync(schemaFilePath, 'utf8');
  const modelNameMatches = schema.matchAll(/^model\s+([A-Za-z_][A-Za-z0-9_]*)\s+\{/gm);
  return new Set(Array.from(modelNameMatches, (match) => match[1]));
}

function listTypeScriptFiles(dirPath: string): string[] {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const filePaths: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      filePaths.push(...listTypeScriptFiles(entryPath));
      continue;
    }

    if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx')
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

function getFromService(relativePath: string): ServiceName | null {
  const fromMatch = relativePath.match(/^src\/backend\/services\/([^/]+)\//);
  if (!fromMatch) {
    return null;
  }

  const serviceName = fromMatch[1];
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
  return {
    toServiceName: toMatch[1],
    toSubpath: toMatch[2] ?? '',
  };
}

function validateCrossServiceImport(
  fromService: ServiceName,
  relativePath: string,
  moduleSpecifier: string,
  allowedDependencies: Set<ServiceName>,
  errors: string[]
): void {
  const serviceImport = parseServiceImport(moduleSpecifier);
  if (!serviceImport) {
    return;
  }

  if (!isRegisteredServiceName(serviceImport.toServiceName)) {
    // Registry scope is service capsules only. Root infra service files are out of scope.
    if (infraServiceFileNames.has(serviceImport.toServiceName)) {
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

function checkCrossServiceImports(errors: string[]): void {
  const serviceFiles = listTypeScriptFiles(servicesRoot);

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

    for (const moduleSpecifier of collectModuleSpecifiers(filePath)) {
      validateCrossServiceImport(
        fromService,
        relativePath,
        moduleSpecifier,
        allowedDependencies,
        errors
      );
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

function main(): void {
  const errors: string[] = [];

  checkRegistryModelList(errors);
  checkDependencyGraph(errors);
  checkCrossServiceImports(errors);

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
