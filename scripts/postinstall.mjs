#!/usr/bin/env node

/**
 * Postinstall script for factory-factory
 *
 * Handles:
 * 1. Prisma client generation in source checkouts only
 * 2. node-pty spawn-helper permissions
 */

import { execFileSync } from 'node:child_process';
import { existsSync, chmodSync, lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const require = createRequire(import.meta.url);

// Source archives and worktrees need generated TypeScript; published installs
// consume the compiled client shipped in dist/prisma/generated instead.
const schemaPath = join(projectRoot, 'prisma', 'schema.prisma');
const isSourceCheckout = existsSync(join(projectRoot, 'src', 'cli', 'index.ts'));
if (isSourceCheckout && existsSync(schemaPath)) {
  try {
    console.log('Generating Prisma client...');
    // Nested npx can wait on the installation lock held by the outer npm exec.
    const prismaCliPath = require.resolve('prisma/build/index.js');
    execFileSync(process.execPath, [prismaCliPath, 'generate', '--schema', schemaPath], {
      stdio: 'inherit',
      cwd: projectRoot,
    });
  } catch (error) {
    console.error('Failed to generate Prisma client:', error.message);
    console.error('Run "pnpm db:generate" in the source checkout before developing or building.');
    // Keep dependency installation usable; development and builds require generation.
  }
}

// node-pty 1.1.0 publishes Darwin helpers without executable permission.
// Resolve the actual dependency rather than searching unrelated ancestor trees.
if (process.platform !== 'win32') {
  try {
    const nativeRoot = realpathSync(dirname(require.resolve('node-pty/package.json')));
    const helper = join(
      nativeRoot,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper'
    );
    if (lstatSync(helper).isFile()) {
      const location = relative(nativeRoot, realpathSync(helper));
      if (location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location)) {
        chmodSync(helper, 0o755);
      }
    }
  } catch {
    // No prebuilt helper on this platform, or the installation is read-only.
  }
}
