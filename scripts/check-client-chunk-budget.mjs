import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';
import { z } from 'zod';

// Keep the startup module and deferred file-rendering modules independently bounded.
// Uncompressed bytes track parse/compile work rather than compression changes.
const budgets = [
  [/^index-.*\.js$/, 650_000],
  [/^file-viewer-.*\.js$/, 20_000],
  [/^diff-highlight\.worker-.*\.js$/, 300_000],
];
export function checkClientChunkBudget(directory, log = console.log) {
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
      log(`${file}: ${size}/${limit} bytes`);
    }
  }

  const sourceManifest = z
    .strictObject({
      version: z.literal(1),
      modules: z.record(z.string(), z.array(z.string())),
    })
    .parse(JSON.parse(readFileSync(join(directory, 'client-modules.json'), 'utf8')));
  const viewerSources = new Set([
    'src/client/features/workspace/file-viewer.tsx',
    'src/client/features/workspace/diff-viewer.tsx',
  ]);

  function checkViewerSources(file) {
    const chunk = relative(directory, file).split(sep).join('/');
    const modules = sourceManifest.modules[chunk];
    if (!modules) {
      throw new Error(`Missing source module metadata for ${chunk}`);
    }
    for (const source of modules) {
      if (viewerSources.has(source)) {
        throw new Error(
          `${chunk}: ${basename(source)} must remain deferred outside the startup static closure`
        );
      }
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
    checkViewerSources(file);
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
  log(
    `startup static closure: ${visited.size} JS files, ${rawBytes}/${startupLimit} raw bytes, ${gzipBytes} gzip bytes`
  );
  if (rawBytes > startupLimit) {
    throw new Error(
      `startup static closure: ${rawBytes} bytes exceeds the ${startupLimit} byte budget`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkClientChunkBudget(resolve(process.argv[2] ?? 'dist/client/assets'));
}
