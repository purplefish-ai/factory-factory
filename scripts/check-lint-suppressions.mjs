import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { cssComments, htmlComments, markdownComments, yamlComments } from './lint-comments.mjs';

const ROOT = process.cwd();
const SCAN_ROOTS = [
  'src',
  'electron',
  'e2e',
  'prompts',
  'scripts',
  'lint-rules',
  'prisma',
  'docs',
  'public',
  '.planning',
  '.github',
  '.storybook',
  '.vscode',
];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-bundle', '.next', 'release']);
const ALLOWED_SUPPRESSION_PREFIXES = ['prisma/generated/'];

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function isSuppressionAllowed(relativePath) {
  const normalized = toPosixPath(relativePath);
  return ALLOWED_SUPPRESSION_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function walkFiles(dirPath, out) {
  if (!fs.existsSync(dirPath)) {
    return;
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      walkFiles(fullPath, out);
      continue;
    }
    out.push(fullPath);
  }
}

function countSuppressions() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    walkFiles(path.join(ROOT, root), files);
  }
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile()) {
      files.push(path.join(ROOT, entry.name));
    }
  }

  let totalSuppressions = 0;
  const filesWithSuppressions = [];

  for (const filePath of files) {
    if (!/\.(?:[cm]?[jt]sx?|css|jsonc?|html|mdx?|ya?ml)$/.test(filePath)) {
      continue;
    }
    const relativePath = toPosixPath(path.relative(ROOT, filePath));
    if (isSuppressionAllowed(relativePath)) {
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    if (!/(?:biome-ignore|(?:oxlint|eslint)-disable|(?:oxfmt|prettier)-ignore)\b/.test(content)) {
      continue;
    }

    const directive =
      /^(?:biome-ignore(?:-all)?|(?:oxlint|eslint)-disable(?:-next-line|-line)?|(?:oxfmt|prettier)-ignore)\b/;
    let count = 0;
    const extension = path.extname(filePath);
    const commentReader = {
      '.css': cssComments,
      '.html': htmlComments,
      '.md': markdownComments,
      '.mdx': markdownComments,
      '.yml': yamlComments,
      '.yaml': yamlComments,
    }[extension];
    if (commentReader) {
      count = commentReader(content).filter((comment) =>
        directive.test(comment.replace(/^(?:\/\*+|<!--|#+)\s*/, ''))
      ).length;
    } else {
      // Parse comment ranges so strings and test fixtures cannot suppress a rule.
      const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
      const comments = new Map();
      function collect(node) {
        for (const position of [node.pos, node.end]) {
          for (const range of [
            ...(ts.getLeadingCommentRanges(content, position) ?? []),
            ...(ts.getTrailingCommentRanges(content, position) ?? []),
          ]) {
            comments.set(range.pos, content.slice(range.pos, range.end));
          }
        }
        for (const child of node.getChildren(source)) {
          collect(child);
        }
      }
      collect(source);
      count = [...comments.values()].filter((comment) =>
        directive.test(comment.replace(/^(?:\/\/|\/\*+)\s*/, ''))
      ).length;
    }
    if (count === 0) {
      continue;
    }

    totalSuppressions += count;
    filesWithSuppressions.push({ relativePath, count });
  }

  return {
    totalSuppressions,
    filesWithSuppressions,
  };
}

function main() {
  const current = countSuppressions();

  if (current.totalSuppressions > 0) {
    console.error(
      `Found ${current.totalSuppressions} inline lint/format suppressions outside prisma/generated/:`
    );
    for (const file of current.filesWithSuppressions) {
      console.error(`- ${file.relativePath}: ${file.count}`);
    }
    process.exit(1);
  }

  console.log('No inline lint/format suppressions found outside prisma/generated/.');
}

main();
