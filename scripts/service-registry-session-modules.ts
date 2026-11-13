import path from 'node:path';
import ts from 'typescript';
import {
  cycleMembership,
  getBackEdgeErrors,
  type ModuleEdge,
  type ModuleGraph,
  sessionModulesFile,
} from './service-registry-session-cycles';

/**
 * The module map inside the `session` capsule.
 *
 * A module is a directory directly under `service/`; files directly under
 * `service/` form the module `root`. `src/backend/services/session/modules.ts`
 * records which modules each module imports and which imports may close a
 * cycle (see service-registry-session-cycles.ts). This file derives the same graph from the syntax tree of the capsule's
 * production files and reports every difference with the line to change.
 */

export const sessionServiceRoot = 'src/backend/services/session/service';
export const sessionRootModule = 'root';
const sessionServiceAlias = '@/backend/services/session/service';

/** Tests and test support, which do not count as dependencies. */
const testFilePattern =
  /(?:^|\/)(?:testing|test-utils)\/|\.test\.tsx?$|\.test-[a-z-]+\.tsx?$|\.fixture\.[^/]+$/u;

export type SessionModuleDeclaration = {
  dependsOn: readonly string[];
  description: string;
  sealed?: boolean;
};

/** A capsule file: repository-relative path and source text. */
export type SessionSourceFile = { path: string; source: string };

/** One importing file's dependency on one sibling module. */
export type SessionModuleEdge = {
  from: string;
  to: string;
  /** Repository-relative path of the importing file. */
  file: string;
  /** Every import from `file` into `to` is type-only. */
  typeOnly: boolean;
};

export type SessionModuleCheckInput = {
  modules: Readonly<Record<string, SessionModuleDeclaration>>;
  /** Directed imports allowed to close a cycle, as written in `sessionModuleCycles`. */
  cycles: readonly ModuleEdge[];
  /** Module directories under `service/`, plus `root` while files sit directly in it. */
  moduleDirectories: readonly string[];
  edges: readonly SessionModuleEdge[];
};

export function isSessionTestFile(filePath: string): boolean {
  return testFilePattern.test(filePath);
}

/** The module a path under `service/` belongs to, or null outside `service/`. */
function moduleOfPath(filePath: string, moduleNames: ReadonlySet<string>): string | null {
  const relativePath = path.posix.relative(sessionServiceRoot, filePath);
  if (relativePath.startsWith('..') || path.posix.isAbsolute(relativePath)) {
    return null;
  }
  const segments = relativePath.split('/');
  const [first] = segments;
  if (first === undefined || first === '') {
    return sessionRootModule;
  }
  if (segments.length > 1 || moduleNames.has(first)) {
    return first;
  }
  return sessionRootModule;
}

/**
 * The modules present among repository-relative TypeScript file paths: each
 * directory under `service/` that holds a production file, and `root` while one
 * sits directly in `service/`. A directory of tests or test support alone, such
 * as `service/testing/`, is not a module.
 */
export function sessionModuleDirectories(filePaths: readonly string[]): string[] {
  const modules = filePaths.flatMap((filePath) => {
    const relativePath = path.posix.relative(sessionServiceRoot, filePath);
    if (
      relativePath.startsWith('..') ||
      path.posix.isAbsolute(relativePath) ||
      isSessionTestFile(filePath)
    ) {
      return [];
    }
    const segments = relativePath.split('/');
    return [segments.length > 1 ? (segments[0] ?? sessionRootModule) : sessionRootModule];
  });
  return [...new Set(modules)].sort();
}

function resolveSpecifier(importingFile: string, specifier: string): string | null {
  if (specifier.startsWith('.')) {
    return path.posix.join(path.posix.dirname(importingFile), specifier);
  }
  if (specifier === sessionServiceAlias || specifier.startsWith(`${sessionServiceAlias}/`)) {
    return `src/${specifier.slice('@/'.length)}`;
  }
  return null;
}

type ModuleReference = { specifier: string; typeOnly: boolean };

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  const clause = node.exportClause;
  return (
    node.isTypeOnly ||
    (clause !== undefined &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((element) => element.isTypeOnly))
  );
}

function statementReference(statement: ts.Statement): ModuleReference | null {
  if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    return { specifier: statement.moduleSpecifier.text, typeOnly: isTypeOnlyImport(statement) };
  }
  if (
    ts.isExportDeclaration(statement) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier)
  ) {
    return { specifier: statement.moduleSpecifier.text, typeOnly: isTypeOnlyExport(statement) };
  }
  return null;
}

/** `import('…')` calls and `import('…').Type` type references anywhere in the file. */
function inlineReferences(sourceFile: ts.SourceFile): ModuleReference[] {
  const references: ModuleReference[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      references.push({ specifier: node.argument.literal.text, typeOnly: true });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      references.push({ specifier: node.arguments[0].text, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

function moduleReferences(file: SessionSourceFile): ModuleReference[] {
  const sourceFile = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, false);
  const references = sourceFile.statements.flatMap((statement) => {
    const reference = statementReference(statement);
    return reference === null ? [] : [reference];
  });
  return [...references, ...inlineReferences(sourceFile)];
}

function fileEdges(
  file: SessionSourceFile,
  from: string,
  moduleNames: ReadonlySet<string>
): SessionModuleEdge[] {
  const typeOnlyByTarget = new Map<string, boolean>();
  for (const reference of moduleReferences(file)) {
    const target = resolveSpecifier(file.path, reference.specifier);
    const to = target === null ? null : moduleOfPath(target, moduleNames);
    if (to !== null && to !== from && moduleNames.has(to)) {
      typeOnlyByTarget.set(to, (typeOnlyByTarget.get(to) ?? true) && reference.typeOnly);
    }
  }
  return [...typeOnlyByTarget].map(([to, typeOnly]) => ({ from, to, file: file.path, typeOnly }));
}

/**
 * Reads the imports, re-exports and type imports of each production file under
 * `service/` and returns one edge per importing file and sibling module. Test
 * files and test support are skipped, and so are imports of anything outside
 * `service/` (`resources/`, `types.ts`, the capsule barrel).
 */
export function collectSessionModuleEdges(
  files: readonly SessionSourceFile[],
  moduleDirectories: readonly string[]
): SessionModuleEdge[] {
  const moduleNames = new Set(moduleDirectories);
  return files.flatMap((file) => {
    const from = moduleOfPath(file.path, moduleNames);
    return from === null || isSessionTestFile(file.path) ? [] : fileEdges(file, from, moduleNames);
  });
}

function quoteList(names: readonly string[]): string {
  return `[${names.map((name) => `'${name}'`).join(', ')}]`;
}

function location(moduleName: string): string {
  return moduleName === sessionRootModule
    ? `the files directly under ${sessionServiceRoot}/`
    : `${sessionServiceRoot}/${moduleName}/`;
}

function describeFiles(edges: readonly SessionModuleEdge[]): string {
  const files = edges.map((edge) => edge.file).sort();
  const shown = files.slice(0, 3).join(', ');
  return files.length > 3 ? `${shown} and ${files.length - 3} more` : shown;
}

function sortedUnique(names: Iterable<string>): string[] {
  return [...new Set(names)].sort();
}

function isSortedUnique(names: readonly string[]): boolean {
  return names.every((name, index) => index === 0 || (names[index - 1] ?? '') < name);
}

type Graph = Map<string, Map<string, SessionModuleEdge[]>>;

function buildGraph(edges: readonly SessionModuleEdge[]): Graph {
  const graph: Graph = new Map();
  for (const edge of edges) {
    const targets = graph.get(edge.from) ?? new Map<string, SessionModuleEdge[]>();
    targets.set(edge.to, [...(targets.get(edge.to) ?? []), edge]);
    graph.set(edge.from, targets);
  }
  return graph;
}

function presenceErrors(input: SessionModuleCheckInput, graph: Graph): string[] {
  const directories = new Set(input.moduleDirectories);
  const unlisted = [...directories]
    .filter((name) => !Object.hasOwn(input.modules, name))
    .sort()
    .map(
      (name) =>
        `Session module "${name}" (${location(name)}) is not listed in sessionModules in ${sessionModulesFile}. Add "${name}": { dependsOn: ${quoteList(sortedUnique(graph.get(name)?.keys() ?? []))}, description: '<what it owns>' }.`
    );
  const missing = Object.keys(input.modules)
    .filter((name) => !directories.has(name))
    .sort()
    .map((name) =>
      name === sessionRootModule
        ? `sessionModules in ${sessionModulesFile} lists "${sessionRootModule}", but no files are left directly under ${sessionServiceRoot}/. Remove the "${sessionRootModule}" entry.`
        : `sessionModules in ${sessionModulesFile} lists "${name}", but ${sessionServiceRoot}/${name}/ does not exist. Remove the "${name}" entry.`
    );
  return [...unlisted, ...missing];
}

function dependencyErrors(
  name: string,
  declaration: SessionModuleDeclaration,
  graph: Graph,
  closesCycle: (from: string, to: string) => boolean
): string[] {
  const field = `sessionModules["${name}"].dependsOn in ${sessionModulesFile}`;
  const imported = graph.get(name) ?? new Map<string, SessionModuleEdge[]>();
  const expected = quoteList(sortedUnique(imported.keys()));
  const declared = new Set(declaration.dependsOn);
  const errors: string[] = [];

  if (!isSortedUnique(declaration.dependsOn)) {
    errors.push(
      `${field} is not sorted or has duplicates; write it as ${quoteList(sortedUnique(declaration.dependsOn))}.`
    );
  }
  for (const to of sortedUnique(imported.keys())) {
    if (!declared.has(to)) {
      const files = describeFiles(imported.get(to) ?? []);
      errors.push(
        closesCycle(name, to)
          ? `Session module "${name}" imports "${to}" in ${files}, which ${field} does not list. The import closes a cycle, reported below, so remove it rather than listing it.`
          : `Session module "${name}" imports "${to}" in ${files}, but ${field} does not list "${to}". Add it (the list becomes ${expected}) or remove the import.`
      );
    }
  }
  for (const to of sortedUnique(declared)) {
    if (imported.has(to)) {
      continue;
    }
    const reason =
      to === name
        ? 'a module cannot depend on itself'
        : `no production file in ${location(name)} imports ${location(to)}`;
    errors.push(
      `${field} lists "${to}", but ${reason}. Remove "${to}"; the list becomes ${expected}.`
    );
  }
  return errors;
}

function moduleGraph(graph: Graph): ModuleGraph {
  return new Map(
    [...graph].map(([from, targets]) => [
      from,
      new Map([...targets].map(([to, edges]) => [to, edges.map((edge) => edge.file).sort()])),
    ])
  );
}

/**
 * Compares the recorded module map with the edges read from source: every
 * module directory is listed and every listed module exists; each module's
 * `dependsOn` is exactly the sorted set of siblings it imports; and the graph
 * without the edges in `sessionModuleCycles` is acyclic, with each listed edge
 * still present and needed. `sealed` is accepted and not yet enforced.
 */
export function getSessionModuleErrors(input: SessionModuleCheckInput): string[] {
  const graph = buildGraph(input.edges);
  const directories = new Set(input.moduleDirectories);
  const listed = new Set(input.cycles.map(([from, to]) => `${from}\u0000${to}`));
  const undeclaredEdges = [...graph].flatMap(([from, targets]) => {
    const declared = new Set(input.modules[from]?.dependsOn ?? []);
    return [...targets.keys()]
      .filter((to) => !declared.has(to))
      .map((to): ModuleEdge => [from, to]);
  });
  const sameCycle = cycleMembership(moduleGraph(graph), input.cycles);
  const closesCycle = (from: string, to: string): boolean =>
    !listed.has(`${from}\u0000${to}`) && sameCycle(from, to);

  return [
    ...presenceErrors(input, graph),
    ...Object.entries(input.modules)
      .filter(([name]) => directories.has(name))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .flatMap(([name, declaration]) => dependencyErrors(name, declaration, graph, closesCycle)),
    ...getBackEdgeErrors({
      graph: moduleGraph(graph),
      backEdges: input.cycles,
      undeclaredEdges,
      serviceRoot: sessionServiceRoot,
    }),
  ];
}
