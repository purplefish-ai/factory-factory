import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const SCAN_ROOTS = ['src', 'electron', 'prompts', 'scripts'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-bundle', '.next', 'release']);

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

  let totalSuppressions = 0;
  const filesWithSuppressions = [];

  for (const filePath of files) {
    const relativePath = path.relative(ROOT, filePath).split(path.sep).join('/');
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const matches = content.match(
      /(?:\/\/|\/\*+|\{\s*\/\*)\s*biome-ignore(?:-all)?\b/g
    );
    const count = matches?.length ?? 0;
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
      `Found ${current.totalSuppressions} inline Biome suppressions outside prisma/generated/:`
    );
    for (const file of current.filesWithSuppressions) {
      console.error(`- ${file.relativePath}: ${file.count}`);
    }
    process.exit(1);
  }

  console.log('No inline Biome suppressions found outside prisma/generated/.');
}

main();
