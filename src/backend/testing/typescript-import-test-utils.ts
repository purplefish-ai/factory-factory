import { readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export const REPOSITORY_ROOT = process.cwd();

export function isProductionTypeScriptFile(fileName: string): boolean {
  const isTypeScript = /\.(?:[cm]?ts|tsx)$/.test(fileName);
  const isTest = /\.(?:test|spec)\.(?:[cm]?ts|tsx)$/.test(fileName);
  const isDeclaration = /\.d\.(?:[cm]?ts|tsx)$/.test(fileName);
  return isTypeScript && !isTest && !isDeclaration;
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
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
  return {
    sourceFile,
    importDeclarations: sourceFile.statements.filter(ts.isImportDeclaration),
  };
}
