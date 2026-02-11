import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const ROOT_DIR = process.cwd();
const SRC_DIR = path.join(ROOT_DIR, 'src');
const VITEST_MOCK_METHODS = new Set(['mock', 'doMock', 'unmock']);

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function collectSourceFiles(dir) {
  const files = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }

    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(entryPath));
      continue;
    }

    if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(entryPath);
    }
  }

  return files;
}

function hasResolvableFile(absoluteStem) {
  return RESOLVABLE_EXTENSIONS.some((ext) => existsSync(`${absoluteStem}${ext}`));
}

function hasResolvableDirectoryIndex(absoluteStem) {
  return RESOLVABLE_EXTENSIONS.some((ext) => existsSync(path.join(absoluteStem, `index${ext}`)));
}

function isParentRelativeSpecifier(specifier) {
  return specifier === '..' || specifier.startsWith('../');
}

function getScriptKind(filePath) {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  return ts.ScriptKind.TS;
}

function isVitestModuleMockCall(node) {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) {
    return false;
  }

  if (!ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }

  const expression = node.expression.expression;
  const methodName = node.expression.name.text;
  return ts.isIdentifier(expression) && expression.text === 'vi' && VITEST_MOCK_METHODS.has(methodName);
}

function findImportViolations(filePath) {
  const source = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath)
  );

  const specifiers = [];

  function addSpecifier(moduleSpecifierNode) {
    if (!moduleSpecifierNode || !ts.isStringLiteralLike(moduleSpecifierNode)) {
      return;
    }

    const { line } = sourceFile.getLineAndCharacterOfPosition(moduleSpecifierNode.getStart());
    specifiers.push({
      specifier: moduleSpecifierNode.text,
      line: line + 1,
    });
  }

  function walk(node) {
    if (ts.isImportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      addSpecifier(node.moduleSpecifier);
    } else if (isVitestModuleMockCall(node)) {
      addSpecifier(node.arguments[0]);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      addSpecifier(node.arguments[0]);
    }

    ts.forEachChild(node, walk);
  }

  walk(sourceFile);

  const parentRelativeFindings = [];
  const ambiguousFindings = [];

  for (const entry of specifiers) {
    const specifier = entry.specifier;
    if (!specifier) {
      continue;
    }

    if (isParentRelativeSpecifier(specifier)) {
      parentRelativeFindings.push({
        file: path.relative(ROOT_DIR, filePath),
        line: entry.line,
        specifier,
      });
      continue;
    }

    if (!specifier.startsWith('.') || path.extname(specifier) !== '') {
      continue;
    }

    const absoluteStem = path.resolve(path.dirname(filePath), specifier);
    if (!hasResolvableFile(absoluteStem)) {
      continue;
    }

    if (!hasResolvableDirectoryIndex(absoluteStem)) {
      continue;
    }

    ambiguousFindings.push({
      file: path.relative(ROOT_DIR, filePath),
      line: entry.line,
      specifier,
    });
  }

  return { parentRelativeFindings, ambiguousFindings };
}

const allSourceFiles = collectSourceFiles(SRC_DIR);
const allParentRelativeFindings = [];
const allAmbiguousFindings = [];

for (const filePath of allSourceFiles) {
  const { parentRelativeFindings, ambiguousFindings } = findImportViolations(filePath);
  allParentRelativeFindings.push(...parentRelativeFindings);
  allAmbiguousFindings.push(...ambiguousFindings);
}

if (allParentRelativeFindings.length === 0 && allAmbiguousFindings.length === 0) {
  process.exit(0);
}

if (allParentRelativeFindings.length > 0) {
  console.error('Parent-relative imports are not allowed. Use @/ aliases for non-local modules:');
  for (const finding of allParentRelativeFindings) {
    console.error(`- ${finding.file}:${finding.line} -> ${finding.specifier}`);
  }
  console.error('Allowed relative imports are limited to ./ only.');
}

if (allAmbiguousFindings.length > 0) {
  console.error('Ambiguous relative import/export specifiers detected:');
  for (const finding of allAmbiguousFindings) {
    console.error(`- ${finding.file}:${finding.line} -> ${finding.specifier}`);
  }
  console.error(
    'Use an explicit file or directory barrel path (for example, "./module/index") to avoid ESM resolution conflicts.'
  );
}

process.exit(1);
