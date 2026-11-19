import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';

const usage = 'Usage: pnpm exec tsx scripts/codemods/typed-vitest-mocks.ts [--write] <file>...';
const sourceExtension = /\.(?:tsx?|[cm]ts)$/;
const workspaceSpecifier = /^(?:\.{1,2}|@|@prisma-gen)\//;
// Vitest's transform first looks for these receiver and method spellings in the source.
const mockCall = /^vi\s*\.\s*(?:mock|doMock)\s*\(/;

function inWorkspace(root: string, path: string): boolean {
  const local = relative(root, path);
  return (
    !isAbsolute(local) &&
    local !== '..' &&
    !local.startsWith(`..${sep}`) &&
    !local.split(sep).includes('node_modules')
  );
}

function configOptions(root: string): ts.CompilerOptions {
  function fail(error: ts.Diagnostic): never {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  }

  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(root, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: fail,
    }
  );
  const error = parsed?.errors[0];
  if (error) {
    fail(error);
  }
  if (!parsed) {
    throw new Error('Could not read tsconfig.json.');
  }
  return parsed.options;
}

function isVitestVi(receiver: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(receiver) || receiver.text !== 'vi') {
    return false;
  }

  const declarations = checker.getSymbolAtLocation(receiver)?.declarations;
  const declaration = declarations?.[0];
  if (declarations?.length !== 1 || !declaration || !ts.isImportSpecifier(declaration)) {
    return false;
  }

  const clause = declaration.parent.parent;
  const module = clause.parent.moduleSpecifier;
  return (
    !(clause.isTypeOnly || declaration.isTypeOnly) &&
    (declaration.propertyName ?? declaration.name).text === 'vi' &&
    ts.isStringLiteral(module) &&
    module.text === 'vitest'
  );
}

type Edit = { start: number; end: number };

function findEdits(
  program: ts.Program,
  source: ts.SourceFile,
  resolvesInWorkspace: (specifier: string) => boolean
): Edit[] {
  const edits: Edit[] = [];
  const checker = program.getTypeChecker();
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const [target] = node.arguments;
      if (
        target &&
        ts.isStringLiteralLike(target) &&
        node.arguments.length === 1 &&
        workspaceSpecifier.test(target.text) &&
        mockCall.test(source.text.slice(node.getStart(source), target.getStart(source))) &&
        isVitestVi(node.expression.expression, checker) &&
        resolvesInWorkspace(target.text)
      ) {
        edits.push({ start: target.getStart(source), end: target.getEnd() });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return edits;
}

function renderEdits(root: string, source: ts.SourceFile, edits: readonly Edit[]) {
  const path = relative(root, source.fileName);
  const preview: string[] = [];
  let updated = '';
  let cursor = 0;
  for (const { start, end } of edits) {
    const { line, character } = source.getLineAndCharacterOfPosition(start);
    const literal = source.text.slice(start, end);
    const replacement = `import(${literal})`;
    preview.push(`${path}:${line + 1}:${character + 1} ${literal} -> ${replacement}`);
    updated += source.text.slice(cursor, start) + replacement;
    cursor = end;
  }
  return { preview, updated: updated + source.text.slice(cursor) };
}

export function runTypedVitestMocks(workspace: string, args: readonly string[]): string {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { write: { type: 'boolean' }, help: { type: 'boolean' } },
    allowPositionals: true,
  });
  if (values.help) {
    return `${usage}\nPreview by default. Pass --write to apply changes.`;
  }
  if (positionals.length === 0) {
    throw new Error(usage);
  }

  const root = realpathSync(workspace);
  const paths = positionals.map((input) => {
    const path = realpathSync(resolve(root, input));
    if (!(inWorkspace(root, path) && statSync(path).isFile())) {
      throw new Error(`Expected a file inside the workspace: ${input}`);
    }
    return path;
  });
  const filePaths = [...new Set(paths)].filter((path) => sourceExtension.test(path)).sort();

  const options = configOptions(root);
  const bindingOptions = { ...options, noResolve: true, noLib: true, types: [] };
  const host = ts.createCompilerHost(bindingOptions);
  host.getSourceFile = (path, languageVersion) =>
    ts.createSourceFile(path, readFileSync(path, 'utf8'), languageVersion, true);
  const program = ts.createProgram(filePaths, bindingOptions, host);
  const cache = ts.createModuleResolutionCache(root, host.getCanonicalFileName, options);

  const report: string[] = [];
  const updates = new Map<string, string>();
  let count = 0;
  for (const source of program.getSourceFiles()) {
    const path = source.fileName;
    if (source.isDeclarationFile) {
      continue;
    }
    if (program.getSyntacticDiagnostics(source).length > 0) {
      throw new Error(`Cannot parse ${relative(root, path)}.`);
    }

    const edits = findEdits(program, source, (specifier) => {
      // TypeScript can resolve these paths even when it rejects them in import().
      if (!options.allowImportingTsExtensions && sourceExtension.test(specifier)) {
        return false;
      }
      const { resolvedModule } = ts.resolveModuleName(specifier, path, options, ts.sys, cache);
      const target = resolvedModule?.resolvedFileName;
      return (
        target !== undefined &&
        !/\.d\.[cm]?ts$/.test(target) &&
        inWorkspace(root, realpathSync(target))
      );
    });
    if (edits.length === 0) {
      continue;
    }

    const result = renderEdits(root, source, edits);
    report.push(...result.preview);
    updates.set(source.fileName, result.updated);
    count += edits.length;
  }

  if (values.write) {
    for (const [path, text] of updates) {
      writeFileSync(path, text);
    }
  }
  const summary = values.write ? 'Updated' : 'Would update';
  report.push(
    `${summary} ${count} mock${count === 1 ? '' : 's'} in ${updates.size} file${updates.size === 1 ? '' : 's'}.`
  );
  return report.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(runTypedVitestMocks(resolve(import.meta.dirname, '../..'), process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
