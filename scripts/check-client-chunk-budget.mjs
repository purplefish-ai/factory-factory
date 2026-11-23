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
const startupLimit = 1_300_000;

// The board is the page phones open most. Its route chunk is found by source module
// because the bundler names shared chunks after whichever export it meets first.
const boardRoute = 'src/client/routes/projects/workspaces/list.tsx';
// Files the board loads beyond the startup closure: 166,246 bytes when set.
const boardLimit = 185_000;
// The markdown renderer and its parsing pipeline load where markdown is shown
// (transcripts, Quick Chat), never with the board itself.
const markdownPackage =
  /^(?:streamdown|react-markdown|unified|micromark(?:-.+)?|remark-.+|rehype-.+|mdast-util-.+)$/;

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

  const manifest = z
    .strictObject({
      version: z.literal(2),
      modules: z.record(z.string(), z.array(z.string())),
      packages: z.record(z.string(), z.array(z.string())),
    })
    .parse(JSON.parse(readFileSync(join(directory, 'client-modules.json'), 'utf8')));
  const viewerSources = new Set([
    'src/client/features/workspace/file-viewer.tsx',
    'src/client/features/workspace/diff-viewer.tsx',
  ]);

  function chunkName(file) {
    return relative(directory, file).split(sep).join('/');
  }

  function metadata(file) {
    const chunk = chunkName(file);
    const modules = manifest.modules[chunk];
    const packages = manifest.packages[chunk];
    if (!modules || !packages) {
      throw new Error(`Missing source module metadata for ${chunk}`);
    }
    return { chunk, modules, packages };
  }

  // A small entry can still eagerly load a large route through shared barrels.
  // Parse emitted JS so comments, strings, and dynamic imports cannot become edges.
  function staticClosure(entry, checkFile) {
    const visited = new Set();
    function visit(file) {
      if (visited.has(file)) {
        return;
      }
      visited.add(file);
      checkFile(file);
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
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
    visit(entry);
    return visited;
  }

  function measure(closure) {
    let rawBytes = 0;
    let gzipBytes = 0;
    for (const file of closure) {
      const bytes = readFileSync(file);
      rawBytes += bytes.length;
      gzipBytes += gzipSync(bytes).length;
    }
    return { rawBytes, gzipBytes };
  }

  const startup = staticClosure(
    join(
      directory,
      files.find((file) => /^index-.*\.js$/.test(file))
    ),
    (file) => {
      if (/^(?:file-viewer|diff-viewer)-.*\.js$/.test(basename(file))) {
        throw new Error(`${file}: viewer must remain deferred outside the startup static closure`);
      }
      const { chunk, modules } = metadata(file);
      for (const source of modules) {
        if (viewerSources.has(source)) {
          throw new Error(
            `${chunk}: ${basename(source)} must remain deferred outside the startup static closure`
          );
        }
      }
    }
  );
  const startupSize = measure(startup);
  log(
    `startup static closure: ${startup.size} JS files, ${startupSize.rawBytes}/${startupLimit} raw bytes, ${startupSize.gzipBytes} gzip bytes`
  );
  if (startupSize.rawBytes > startupLimit) {
    throw new Error(
      `startup static closure: ${startupSize.rawBytes} bytes exceeds the ${startupLimit} byte budget`
    );
  }

  const boardChunks = Object.entries(manifest.modules)
    .filter(([, modules]) => modules.includes(boardRoute))
    .map(([chunk]) => chunk);
  if (boardChunks.length !== 1) {
    throw new Error(
      `Expected exactly one chunk containing ${boardRoute}; found ${boardChunks.length}`
    );
  }
  const board = staticClosure(join(directory, boardChunks[0]), (file) => {
    const { chunk, packages } = metadata(file);
    for (const name of packages) {
      if (markdownPackage.test(name)) {
        throw new Error(
          `${chunk}: board route static closure must not contain ${name}; load markdown where it renders`
        );
      }
    }
  });
  const boardOnly = [...board].filter((file) => !startup.has(file));
  const boardSize = measure(boardOnly);
  log(
    `board route static closure: ${boardOnly.length} JS files beyond startup, ${boardSize.rawBytes}/${boardLimit} raw bytes, ${boardSize.gzipBytes} gzip bytes`
  );
  if (boardSize.rawBytes > boardLimit) {
    throw new Error(
      `board route static closure: ${boardSize.rawBytes} bytes exceeds the ${boardLimit} byte budget`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkClientChunkBudget(resolve(process.argv[2] ?? 'dist/client/assets'));
}
