import path from 'node:path';
import ts from 'typescript';

/**
 * Bridge-wired service dependencies, read from source.
 *
 * Capsules may not import each other in a cycle, so orchestration hands one
 * capsule another capsule's capabilities at startup through a `configure*()`
 * or `setHandler()` call. Those edges never appear as imports, but they are
 * real runtime dependencies. This module finds them by resolving, with the
 * type checker, every symbol referenced in the arguments of such a call and
 * attributing it to the capsule that declares it.
 *
 * What it can see: direct references to a capsule's exports (services,
 * functions, methods reached through a `Pick<typeof service, ...>`), followed
 * through local `const` helpers in the same file. What it deliberately does
 * not see: callbacks into orchestration functions. Those are orchestration's
 * own coordination, not a capability of another capsule, so they are not
 * service dependencies.
 */

export type BridgeEdge = {
  /** Capsule whose `configure*()`/`setHandler()` receives the capability. */
  from: string;
  /** Capsule that declares the capability. */
  to: string;
  /** Repository-relative file and line of the wiring call. */
  site: string;
};

export type BridgeScanOptions = {
  repositoryRoot: string;
  /** Absolute paths of files whose wiring calls are scanned. */
  wiringFiles: readonly string[];
  /** Capsule names that may appear on either side of an edge. */
  serviceNames: ReadonlySet<string>;
  compilerOptions?: ts.CompilerOptions;
};

const wiringMethodPattern = /^(?:configure[A-Z]\w*|configure|setHandler)$/u;

function readCompilerOptions(repositoryRoot: string): ts.CompilerOptions {
  const configPath = path.join(repositoryRoot, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, (filePath) => ts.sys.readFile(filePath));
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repositoryRoot);
  return { ...parsed.options, noEmit: true, incremental: false };
}

function serviceOfFile(
  fileName: string,
  servicesRoot: string,
  serviceNames: ReadonlySet<string>
): string | null {
  const relativePath = path.relative(servicesRoot, path.resolve(fileName));
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  const [serviceName] = relativePath.split(path.sep);
  return serviceName !== undefined && serviceNames.has(serviceName) ? serviceName : null;
}

function resolveSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  // `{ markIdle }` names the object property; the value is the local binding.
  const symbol =
    ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

class BridgeScanner {
  private readonly servicesRoot: string;

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly options: BridgeScanOptions
  ) {
    this.servicesRoot = path.join(options.repositoryRoot, 'src/backend/services');
  }

  private serviceOf(fileName: string): string | null {
    return serviceOfFile(fileName, this.servicesRoot, this.options.serviceNames);
  }

  private servicesOfSymbol(symbol: ts.Symbol | undefined): Set<string> {
    const services = new Set<string>();
    for (const declaration of symbol?.declarations ?? []) {
      const serviceName = this.serviceOf(declaration.getSourceFile().fileName);
      if (serviceName) {
        services.add(serviceName);
      }
    }
    return services;
  }

  /** Capsule that owns the receiver of `receiver.configure(...)`. */
  receiverService(call: ts.CallExpression): string | null {
    if (!ts.isPropertyAccessExpression(call.expression)) {
      return null;
    }
    if (!wiringMethodPattern.test(call.expression.name.text)) {
      return null;
    }
    const [serviceName] = this.servicesOfSymbol(resolveSymbol(this.checker, call.expression.name));
    return serviceName ?? null;
  }

  /** Edges for one call, empty unless it is a wiring call on a capsule. */
  edgesForCall(call: ts.CallExpression, relativePath: string): BridgeEdge[] {
    const from = this.receiverService(call);
    if (!from) {
      return [];
    }
    const line = call.getSourceFile().getLineAndCharacterOfPosition(call.getStart()).line + 1;
    const providers = new Set(call.arguments.flatMap((arg) => [...this.referencedServices(arg)]));
    providers.delete(from);
    return [...providers].map((to) => ({ from, to, site: `${relativePath}:${line}` }));
  }

  /** Every capsule whose declarations are referenced from `root`. */
  referencedServices(root: ts.Node): Set<string> {
    const services = new Set<string>();
    const visitedDeclarations = new Set<ts.Node>();
    const wiringFile = root.getSourceFile();

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const symbol = resolveSymbol(this.checker, node);
        for (const serviceName of this.servicesOfSymbol(symbol)) {
          services.add(serviceName);
        }
        for (const declaration of symbol?.declarations ?? []) {
          // Follow local helpers (`const markIdle = ...`) defined in the
          // wiring file itself; their bodies are part of the bridge.
          if (
            declaration.getSourceFile() === wiringFile &&
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer &&
            !visitedDeclarations.has(declaration)
          ) {
            visitedDeclarations.add(declaration);
            visit(declaration.initializer);
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(root);
    return services;
  }
}

export function collectBridgeEdges(options: BridgeScanOptions): BridgeEdge[] {
  const program = ts.createProgram({
    rootNames: [...options.wiringFiles],
    options: options.compilerOptions ?? readCompilerOptions(options.repositoryRoot),
  });
  const checker = program.getTypeChecker();
  const scanner = new BridgeScanner(checker, options);
  const edges: BridgeEdge[] = [];

  for (const wiringFile of options.wiringFiles) {
    const sourceFile = program.getSourceFile(wiringFile);
    if (!sourceFile) {
      throw new Error(`Unable to read bridge wiring file: ${wiringFile}`);
    }
    const relativePath = path.relative(options.repositoryRoot, wiringFile).replaceAll('\\', '/');

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        edges.push(...scanner.edgesForCall(node, relativePath));
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return edges.toSorted(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.site.localeCompare(right.site)
  );
}
