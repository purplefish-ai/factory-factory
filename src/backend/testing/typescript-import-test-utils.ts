import { readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export const REPOSITORY_ROOT = process.cwd();

export function isProductionTypeScriptFile(fileName: string): boolean {
  return (
    fileName.endsWith('.ts') &&
    !fileName.endsWith('.test.ts') &&
    !fileName.endsWith('.spec.ts') &&
    !fileName.endsWith('.d.ts')
  );
}

export function discoverProductionTypeScriptFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && isProductionTypeScriptFile(entry.name))
    .map((entry) => relative(REPOSITORY_ROOT, join(entry.parentPath, entry.name)))
    .sort();
}

export function normalizeRepositoryPath(path: string): string {
  return path
    .split(sep)
    .join('/')
    .replace(/\.(?:[cm]?ts|[cm]?js)x?$/, '');
}

export function resolveRepositoryModule(importer: string, moduleSpecifier: string): string | null {
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

  return normalizeRepositoryPath(relative(REPOSITORY_ROOT, absolutePath));
}

export function parseTypeScriptImports(
  source: string,
  fileName: string
): {
  readonly sourceFile: ts.SourceFile;
  readonly importDeclarations: readonly ts.ImportDeclaration[];
} {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  return {
    sourceFile,
    importDeclarations: sourceFile.statements.filter(ts.isImportDeclaration),
  };
}
