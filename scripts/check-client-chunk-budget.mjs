import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';

// Keep the startup module and deferred file-rendering modules independently bounded.
// Uncompressed bytes track parse/compile work rather than compression changes.
const budgets = [
  [/^index-.*\.js$/, 650_000],
  [/^file-viewer-.*\.js$/, 20_000],
  [/^diff-highlight\.worker-.*\.js$/, 300_000],
];
const directory = resolve(process.argv[2] ?? 'dist/client/assets');
const files = readdirSync(directory);
for (const [pattern, limit] of budgets) {
  const matching = files.filter((file) => pattern.test(file));
  if (matching.length !== 1) {
    throw new Error(`Expected exactly one ${pattern} chunk; found ${matching.length}`);
  }
  for (const file of matching) {
    const size = statSync(join(directory, file)).size;
    if (size > limit) {
      throw new Error(`${file}: ${size} bytes exceeds the ${limit} byte budget`);
    }
    console.log(`${file}: ${size}/${limit} bytes`);
  }
}

// A small entry can still eagerly load a large route through shared barrels.
// Parse emitted JS so comments, strings, and dynamic imports cannot become edges.
const startupLimit = 1_300_000;
const visited = new Set();
let rawBytes = 0;
let gzipBytes = 0;
function visit(file) {
  if (visited.has(file)) {
    return;
  }
  visited.add(file);
  if (/^(?:file-viewer|diff-viewer)-.*\.js$/.test(basename(file))) {
    throw new Error(`${file}: viewer must remain deferred outside the startup static closure`);
  }
  const bytes = readFileSync(file);
  rawBytes += bytes.length;
  gzipBytes += gzipSync(bytes).length;
  const source = ts.createSourceFile(file, bytes.toString('utf8'), ts.ScriptTarget.Latest);
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const target = statement.moduleSpecifier.text;
      if (target.startsWith('.') && target.endsWith('.js')) {
        visit(resolve(dirname(file), target));
      }
    }
  }
}
visit(
  join(
    directory,
    files.find((file) => /^index-.*\.js$/.test(file))
  )
);
console.log(
  `startup static closure: ${visited.size} JS files, ${rawBytes}/${startupLimit} raw bytes, ${gzipBytes} gzip bytes`
);
if (rawBytes > startupLimit) {
  throw new Error(
    `startup static closure: ${rawBytes} bytes exceeds the ${startupLimit} byte budget`
  );
}
