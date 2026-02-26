/**
 * Post-build fixup: ensure all relative imports in compiled Prisma output
 * use .js extensions for Node.js ESM compatibility.
 *
 * Handles two cases:
 * 1. Prisma generates explicit .ts extensions (Prisma 7.4.0 and earlier):
 *    tsc with moduleResolution:"bundler" preserves .ts extensions → rewrite to .js
 * 2. Prisma generates bare relative imports (Prisma 7.4.1+):
 *    tsc-alias --resolve-full-paths should add .js, but as a fallback,
 *    explicitly add .js to any bare relative imports that are missing an extension.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

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
  const dir = dirname(file);

  // Step 1: rewrite explicit .ts extensions to .js
  let fixed = src.replace(
    /(from\s+['"])([^'"]+)\.ts(['"])/g,
    "$1$2.js$3",
  );

  // Step 2: add .js to bare relative imports that have no extension
  // Matches: from "./foo" or from "../foo" (no extension after last segment)
  fixed = fixed.replace(
    /(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g,
    (match, prefix, importPath, suffix) => {
      // Skip if already has an extension
      if (/\.[a-z]+$/i.test(importPath)) {
        return match;
      }
      // Check if the .js file actually exists in dist
      const candidate = resolve(dir, importPath + ".js");
      if (existsSync(candidate)) {
        return `${prefix}${importPath}.js${suffix}`;
      }
      // Try index.js
      const indexCandidate = resolve(dir, importPath, "index.js");
      if (existsSync(indexCandidate)) {
        return `${prefix}${importPath}/index.js${suffix}`;
      }
      return match;
    },
  );

  if (fixed !== src) {
    await writeFile(file, fixed);
    rewritten++;
  }
}

console.log(
  `fix-prisma-imports: fixed imports in ${rewritten}/${files.length} files`,
);
