import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const SOURCE_ROOT = 'src/backend';

const ACCESSOR_POLICIES = {
  projectAccessor: {
    owner: 'workspace',
    module: 'src/backend/services/workspace/resources/project.accessor',
  },
  workspaceAccessor: {
    owner: 'workspace',
    module: 'src/backend/services/workspace/resources/workspace.accessor',
  },
  workspaceNotificationAccessor: {
    owner: 'workspace',
    module: 'src/backend/services/workspace/resources/workspace-notification.accessor',
  },
  agentSessionAccessor: {
    owner: 'session',
    module: 'src/backend/services/session/resources/agent-session.accessor',
  },
  closedSessionAccessor: {
    owner: 'session',
    module: 'src/backend/services/session/resources/closed-session.accessor',
  },
  userSettingsAccessor: {
    owner: 'settings',
    module: 'src/backend/services/settings/resources/user-settings.accessor',
  },
  healthAccessor: {
    owner: 'settings',
    module: 'src/backend/services/settings/resources/health.accessor',
  },
  dataBackupAccessor: {
    owner: 'settings',
    module: 'src/backend/services/settings/resources/data-backup.accessor',
  },
  terminalSessionAccessor: {
    owner: 'terminal',
    module: 'src/backend/services/terminal/resources/terminal-session.accessor',
  },
  decisionLogAccessor: {
    owner: 'decision-log',
    module: 'src/backend/services/decision-log/resources/decision-log.accessor',
  },
  periodicTaskAccessor: {
    owner: 'periodic-task',
    module: 'src/backend/services/periodic-task/resources/periodic-task.accessor',
  },
};

const POLICY_BY_MODULE = new Map(
  Object.entries(ACCESSOR_POLICIES).map(([binding, policy]) => [policy.module, { binding, ...policy }])
);

const CROSS_OWNER_EXCEPTIONS = new Set([
  [
    'src/backend/orchestration/data-backup.service.ts',
    'src/backend/services/settings/resources/data-backup.accessor',
  ].join('::'),
]);

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function withoutSourceExtension(filePath) {
  return filePath.replace(/\.(?:[cm]?[jt]sx?)$/, '');
}

function collectSourceFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function canonicalModule(importerPath, moduleSpecifier) {
  if (moduleSpecifier.startsWith('@/backend/')) {
    return withoutSourceExtension(`src/backend/${moduleSpecifier.slice('@/backend/'.length)}`);
  }

  if (moduleSpecifier.startsWith('.')) {
    return withoutSourceExtension(
      toPosix(path.normalize(path.join(path.dirname(importerPath), moduleSpecifier)))
    );
  }

  return null;
}

function capsuleOwner(filePath) {
  const match = /^src\/backend\/services\/([^/]+)\//.exec(filePath);
  return match?.[1] ?? null;
}

function barrelOwner(modulePath) {
  const match = /^src\/backend\/services\/([^/]+)(?:\/index)?$/.exec(modulePath);
  return match?.[1] ?? null;
}

function isCapsuleBarrel(filePath) {
  return /^src\/backend\/services\/[^/]+\/index\.(?:tsx?|mts|cts)$/.test(filePath);
}

function isAccessorModule(modulePath) {
  return /\/resources\/[^/]+\.accessor$/.test(modulePath);
}

function importedNames(importDeclaration) {
  const clause = importDeclaration.importClause;
  if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    return [];
  }

  return clause.namedBindings.elements.map((element) =>
    (element.propertyName ?? element.name).text
  );
}

function exportedNames(exportDeclaration) {
  if (!exportDeclaration.exportClause || !ts.isNamedExports(exportDeclaration.exportClause)) {
    return [];
  }

  return exportDeclaration.exportClause.elements.map((element) =>
    (element.propertyName ?? element.name).text
  );
}

function unwrapTransparentExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function parseModuleRecords(sourceFiles, rootDir) {
  const records = new Map();

  for (const absolutePath of sourceFiles) {
    const filePath = toPosix(path.relative(rootDir, absolutePath));
    const modulePath = withoutSourceExtension(filePath);
    const sourceFile = ts.createSourceFile(
      filePath,
      readFileSync(absolutePath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const record = {
      filePath,
      modulePath,
      imports: [],
      namespaceImports: [],
      localAliases: [],
      localExports: [],
      namedReExports: [],
      namespaceReExports: [],
      starReExports: [],
    };

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const importedModule = canonicalModule(filePath, statement.moduleSpecifier.text);
        const namedBindings = statement.importClause?.namedBindings;
        if (importedModule && namedBindings && ts.isNamedImports(namedBindings)) {
          for (const element of namedBindings.elements) {
            record.imports.push({
              imported: (element.propertyName ?? element.name).text,
              local: element.name.text,
              modulePath: importedModule,
            });
          }
        } else if (importedModule && namedBindings && ts.isNamespaceImport(namedBindings)) {
          record.namespaceImports.push({
            local: namedBindings.name.text,
            modulePath: importedModule,
          });
        }
        continue;
      }

      if (!ts.isExportDeclaration(statement)) {
        if (ts.isVariableStatement(statement)) {
          const isExported = statement.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
          );
          for (const declaration of statement.declarationList.declarations) {
            const initializer = declaration.initializer
              ? unwrapTransparentExpression(declaration.initializer)
              : null;
            if (
              ts.isIdentifier(declaration.name) &&
              initializer &&
              ts.isIdentifier(initializer)
            ) {
              record.localAliases.push({
                local: declaration.name.text,
                target: initializer.text,
              });
              if (isExported) {
                record.localExports.push({
                  local: declaration.name.text,
                  exported: declaration.name.text,
                });
              }
            }
          }
        }

        if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
          const expression = unwrapTransparentExpression(statement.expression);
          if (ts.isIdentifier(expression)) {
            record.localExports.push({ local: expression.text, exported: 'default' });
          }
        }
        continue;
      }

      const exportedModule =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? canonicalModule(filePath, statement.moduleSpecifier.text)
          : null;

      if (!statement.exportClause) {
        if (exportedModule) {
          record.starReExports.push(exportedModule);
        }
        continue;
      }

      if (ts.isNamespaceExport(statement.exportClause)) {
        if (exportedModule) {
          record.namespaceReExports.push({
            exported: statement.exportClause.name.text,
            modulePath: exportedModule,
          });
        }
        continue;
      }

      if (!ts.isNamedExports(statement.exportClause)) {
        continue;
      }

      for (const element of statement.exportClause.elements) {
        const importedOrLocal = (element.propertyName ?? element.name).text;
        const exported = element.name.text;
        if (exportedModule) {
          record.namedReExports.push({
            imported: importedOrLocal,
            exported,
            modulePath: exportedModule,
          });
        } else {
          record.localExports.push({ local: importedOrLocal, exported });
        }
      }
    }

    records.set(modulePath, record);
  }

  return records;
}

function resolveSourceModule(modulePath, records) {
  if (records.has(modulePath)) {
    return modulePath;
  }

  const indexModule = `${modulePath}/index`;
  return records.has(indexModule) ? indexModule : modulePath;
}

function checkCapsuleBarrelExportChains(sourceFiles, rootDir, violations) {
  const records = parseModuleRecords(sourceFiles, rootDir);
  const exportsByModule = new Map(
    [...records.keys()].map((modulePath) => [modulePath, new Map()])
  );

  for (const [binding, policy] of Object.entries(ACCESSOR_POLICIES)) {
    const modulePath = resolveSourceModule(policy.module, records);
    const moduleExports = exportsByModule.get(modulePath) ?? new Map();
    moduleExports.set(binding, binding);
    exportsByModule.set(modulePath, moduleExports);
  }

  let changed = true;
  while (changed) {
    changed = false;

    for (const record of records.values()) {
      const moduleExports = exportsByModule.get(record.modulePath);
      const localBindings = new Map();
      const ownAccessorPolicy = POLICY_BY_MODULE.get(record.modulePath);
      if (ownAccessorPolicy) {
        localBindings.set(ownAccessorPolicy.binding, ownAccessorPolicy.binding);
      }

      for (const importedBinding of record.imports) {
        const importedModule = resolveSourceModule(importedBinding.modulePath, records);
        const accessorBinding = exportsByModule.get(importedModule)?.get(importedBinding.imported);
        if (accessorBinding) {
          localBindings.set(importedBinding.local, accessorBinding);
        }
      }

      for (const namespaceImport of record.namespaceImports) {
        const importedModule = resolveSourceModule(namespaceImport.modulePath, records);
        const accessorBinding = exportsByModule.get(importedModule)?.values().next().value;
        if (accessorBinding) {
          localBindings.set(namespaceImport.local, accessorBinding);
        }
      }

      let aliasesChanged = true;
      while (aliasesChanged) {
        aliasesChanged = false;
        for (const alias of record.localAliases) {
          const accessorBinding = localBindings.get(alias.target);
          if (accessorBinding && !localBindings.has(alias.local)) {
            localBindings.set(alias.local, accessorBinding);
            aliasesChanged = true;
          }
        }
      }

      for (const localExport of record.localExports) {
        const accessorBinding = localBindings.get(localExport.local);
        if (accessorBinding && !moduleExports.has(localExport.exported)) {
          moduleExports.set(localExport.exported, accessorBinding);
          changed = true;
        }
      }

      for (const reExport of record.namedReExports) {
        const reExportedModule = resolveSourceModule(reExport.modulePath, records);
        const accessorBinding = exportsByModule.get(reExportedModule)?.get(reExport.imported);
        if (accessorBinding && !moduleExports.has(reExport.exported)) {
          moduleExports.set(reExport.exported, accessorBinding);
          changed = true;
        }
      }

      for (const reExport of record.namespaceReExports) {
        const reExportedModule = resolveSourceModule(reExport.modulePath, records);
        const accessorBinding = exportsByModule.get(reExportedModule)?.values().next().value;
        if (accessorBinding && !moduleExports.has(reExport.exported)) {
          moduleExports.set(reExport.exported, accessorBinding);
          changed = true;
        }
      }

      for (const starModule of record.starReExports) {
        const reExportedModule = resolveSourceModule(starModule, records);
        for (const [exported, accessorBinding] of exportsByModule.get(reExportedModule) ?? []) {
          if (exported !== 'default' && !moduleExports.has(exported)) {
            moduleExports.set(exported, accessorBinding);
            changed = true;
          }
        }
      }
    }
  }

  for (const record of records.values()) {
    const exposedAccessors = new Set(exportsByModule.get(record.modulePath)?.values() ?? []);
    for (const accessorBinding of exposedAccessors) {
      if (isCapsuleBarrel(record.filePath)) {
        violations.push(
          `${record.filePath}: capsule barrel exposes raw persistence accessor ${accessorBinding}`
        );
        continue;
      }

      const policy = ACCESSOR_POLICIES[accessorBinding];
      if (policy && capsuleOwner(record.filePath) !== policy.owner) {
        violations.push(
          `${record.filePath}: cross-owner re-export of raw persistence accessor ${accessorBinding}`
        );
      }
    }
  }
}

function isExactException(importerPath, modulePath) {
  return CROSS_OWNER_EXCEPTIONS.has(`${importerPath}::${modulePath}`);
}

function checkDeepAccessorReference(
  importerPath,
  modulePath,
  violations,
  allowExactImportException = false
) {
  if (!isAccessorModule(modulePath)) {
    return;
  }

  const policy = POLICY_BY_MODULE.get(modulePath);
  if (!policy) {
    violations.push(
      `${importerPath}: raw persistence accessor module has no ownership policy: ${modulePath}`
    );
    return;
  }

  if (
    capsuleOwner(importerPath) !== policy.owner &&
    !(allowExactImportException && isExactException(importerPath, modulePath))
  ) {
    violations.push(
      `${importerPath}: cross-owner raw persistence accessor ${policy.binding} belongs to ${policy.owner}`
    );
  }
}

function checkBarrelBindings(importerPath, modulePath, names, violations) {
  const importedBarrelOwner = barrelOwner(modulePath);
  if (!importedBarrelOwner || capsuleOwner(importerPath) === importedBarrelOwner) {
    return;
  }

  for (const name of names) {
    const policy = ACCESSOR_POLICIES[name];
    if (policy?.owner === importedBarrelOwner) {
      violations.push(
        `${importerPath}: raw persistence accessor ${name} imported from ${importedBarrelOwner} capsule barrel`
      );
    }
  }
}

function checkDeepAccessorModuleText(importerPath, moduleSpecifier, violations) {
  const modulePath = canonicalModule(importerPath, moduleSpecifier);
  if (modulePath) {
    checkDeepAccessorReference(importerPath, modulePath, violations);
  }
}

function checkNestedModuleReferences(sourceFile, importerPath, violations) {
  function visit(node) {
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      checkDeepAccessorModuleText(importerPath, node.argument.literal.text, violations);
    }

    if (ts.isCallExpression(node)) {
      const moduleArgument = node.arguments[0];
      if (moduleArgument && ts.isStringLiteralLike(moduleArgument)) {
        checkDeepAccessorModuleText(importerPath, moduleArgument.text, violations);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function checkSourceFile(absolutePath, rootDir, violations) {
  const importerPath = toPosix(path.relative(rootDir, absolutePath));
  const sourceText = readFileSync(absolutePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    importerPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    importerPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  checkNestedModuleReferences(sourceFile, importerPath, violations);

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const modulePath = canonicalModule(importerPath, statement.moduleSpecifier.text);
      if (!modulePath) {
        continue;
      }

      checkDeepAccessorReference(importerPath, modulePath, violations, true);
      checkBarrelBindings(importerPath, modulePath, importedNames(statement), violations);
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const modulePath = canonicalModule(importerPath, statement.moduleSpecifier.text);
      if (!modulePath) {
        continue;
      }

      if (isCapsuleBarrel(importerPath) && isAccessorModule(modulePath)) {
        if (!POLICY_BY_MODULE.has(modulePath)) {
          violations.push(
            `${importerPath}: capsule barrel exports raw persistence accessor module ${statement.moduleSpecifier.text}`
          );
        }
        continue;
      }

      checkDeepAccessorReference(importerPath, modulePath, violations);
      checkBarrelBindings(importerPath, modulePath, exportedNames(statement), violations);
    }
  }
}

function checkAccessorPolicyCoverage(sourceFiles, rootDir, violations) {
  for (const absolutePath of sourceFiles) {
    const relativePath = toPosix(path.relative(rootDir, absolutePath));
    const modulePath = withoutSourceExtension(relativePath);
    if (isAccessorModule(modulePath) && !POLICY_BY_MODULE.has(modulePath)) {
      violations.push(`${relativePath}: raw persistence accessor module has no ownership policy`);
    }
  }
}

const rootDir = process.cwd();
const sourceRoot = path.join(rootDir, SOURCE_ROOT);
let sourceFiles = [];

try {
  sourceFiles = collectSourceFiles(sourceRoot);
} catch (error) {
  if (error?.code !== 'ENOENT') {
    throw error;
  }
}

const violations = [];
checkAccessorPolicyCoverage(sourceFiles, rootDir, violations);
for (const sourceFile of sourceFiles) {
  checkSourceFile(sourceFile, rootDir, violations);
}
checkCapsuleBarrelExportChains(sourceFiles, rootDir, violations);

if (violations.length > 0) {
  console.error('Service accessor boundary violations:');
  for (const violation of [...new Set(violations)].sort()) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log('Service accessor boundaries check passed.');
}
