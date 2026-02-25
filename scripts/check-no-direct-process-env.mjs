import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next']);
const BACKEND_ROOT = 'src/backend';

const DEFAULT_ALLOWLISTED_FILES = new Set([
  'src/backend/lib/env.ts',
  'src/backend/services/config.service.ts',
  'src/backend/services/logger.service.ts',
  'src/backend/domains/terminal/terminal.service.ts',
  'src/backend/domains/run-script/startup-script.service.ts',
  'src/backend/domains/session/acp/codex-app-server-adapter/codex-app-server-acp-adapter.ts',
  'src/backend/domains/session/data/codex-session-history-loader.service.ts',
  'src/backend/domains/session/store/file-lock.service.ts',
]);

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function isTestOrFixtureFile(relativePath) {
  return (
    relativePath.endsWith('.test.ts') ||
    relativePath.endsWith('.test.tsx') ||
    relativePath.endsWith('.manual.integration.test.ts') ||
    relativePath.endsWith('.stories.tsx') ||
    relativePath.includes('/testing/')
  );
}

function collectSourceFiles(dirPath, files) {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      collectSourceFiles(fullPath, files);
      continue;
    }

    const extension = path.extname(entry.name);
    if (SOURCE_EXTENSIONS.has(extension)) {
      files.push(fullPath);
    }
  }
}

function getScriptKind(filePath) {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  return ts.ScriptKind.TS;
}

function isProcessEnvAccessNode(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env'
  );
}

function findViolationsInSource(sourceFile) {
  const violations = [];

  function addViolation(node) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      line: line + 1,
      column: character + 1,
    });
  }

  function walk(node) {
    if (ts.isPropertyAccessExpression(node)) {
      if (isProcessEnvAccessNode(node)) {
        const parent = node.parent;
        const consumedByMemberAccess =
          (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
          (ts.isElementAccessExpression(parent) && parent.expression === node);
        if (!consumedByMemberAccess) {
          addViolation(node);
        }
      } else if (isProcessEnvAccessNode(node.expression)) {
        addViolation(node);
      }
    } else if (ts.isElementAccessExpression(node) && isProcessEnvAccessNode(node.expression)) {
      addViolation(node);
    }

    ts.forEachChild(node, walk);
  }

  walk(sourceFile);
  return violations;
}

export function findProcessEnvViolations(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const backendRoot = options.backendRoot ?? BACKEND_ROOT;
  const allowlistedFiles = options.allowlistedFiles ?? DEFAULT_ALLOWLISTED_FILES;
  const backendDir = path.join(rootDir, backendRoot);
  const sourceFiles = [];
  collectSourceFiles(backendDir, sourceFiles);

  const violations = [];
  for (const sourcePath of sourceFiles) {
    const relativePath = toPosixPath(path.relative(rootDir, sourcePath));
    if (allowlistedFiles.has(relativePath) || isTestOrFixtureFile(relativePath)) {
      continue;
    }

    const sourceText = readFileSync(sourcePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      sourcePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(sourcePath)
    );
    const fileViolations = findViolationsInSource(sourceFile);
    for (const violation of fileViolations) {
      violations.push({
        file: relativePath,
        line: violation.line,
        column: violation.column,
      });
    }
  }

  return violations;
}

function main() {
  const violations = findProcessEnvViolations();
  if (violations.length === 0) {
    console.log('No disallowed direct process.env access found in src/backend.');
    return;
  }

  console.error('Disallowed direct process.env access detected. Route env access through configService.');
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line}:${violation.column}`);
  }
  console.error('If a file must directly access process.env, add it to the allowlist in this script.');
  process.exit(1);
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
