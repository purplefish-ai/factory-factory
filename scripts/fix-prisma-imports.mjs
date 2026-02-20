/**
 * Post-build fixup: rewrite .ts import specifiers to .js in compiled Prisma output.
 *
 * Prisma 7.x generates TypeScript files with explicit .ts extensions in imports.
 * tsc with moduleResolution:"bundler" preserves those extensions in the compiled .js,
 * but Node.js can't load .ts files at runtime. The compiled .js counterparts already
 * exist, so we just need to point the imports at them.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const GENERATED_DIR = join("dist", "prisma", "generated");

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.name.endsWith(".js")) {
      files.push(full);
    }
  }
  return files;
}

const files = await walk(GENERATED_DIR);
let rewritten = 0;

for (const file of files) {
  const src = await readFile(file, "utf8");
  // Rewrite  from "….ts"  and  from '….ts'  to use .js extension
  const fixed = src.replace(
    /(from\s+['"])([^'"]+)\.ts(['"])/g,
    "$1$2.js$3",
  );
  if (fixed !== src) {
    await writeFile(file, fixed);
    rewritten++;
  }
}

console.log(
  `fix-prisma-imports: rewrote .ts → .js in ${rewritten}/${files.length} files`,
);
