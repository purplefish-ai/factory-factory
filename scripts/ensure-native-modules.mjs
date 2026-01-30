#!/usr/bin/env node
/**
 * Ensures native modules (better-sqlite3, node-pty) are compiled for the correct target.
 * Caches compiled binaries to enable instant switching between Electron and Node.js.
 *
 * Usage:
 *   node scripts/ensure-native-modules.mjs node      # For web/CLI development
 *   node scripts/ensure-native-modules.mjs electron  # For Electron development
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE_DIR = join(ROOT, '.native-cache');
const MARKER_FILE = join(CACHE_DIR, '.current-target');

const NATIVE_MODULES = [
  {
    name: 'better-sqlite3',
    files: ['better_sqlite3.node'],
  },
  {
    name: 'node-pty',
    files: ['pty.node'],
  },
];

function findModulePath(moduleName) {
  // Find the module in pnpm's node_modules structure
  const pnpmDir = join(ROOT, 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) {
    return null;
  }

  const entries = readdirSync(pnpmDir);
  const match = entries.find(e => e.startsWith(`${moduleName}@`));
  if (!match) {
    return null;
  }

  return join(pnpmDir, match, 'node_modules', moduleName, 'build', 'Release');
}

function getCurrentTarget() {
  if (!existsSync(MARKER_FILE)) {
    return null;
  }
  return readFileSync(MARKER_FILE, 'utf-8').trim();
}

function setCurrentTarget(target) {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
  writeFileSync(MARKER_FILE, target);
}

function getCachePath(target, moduleName) {
  return join(CACHE_DIR, target, moduleName);
}

function cacheExists(target) {
  for (const mod of NATIVE_MODULES) {
    const cachePath = getCachePath(target, mod.name);
    for (const file of mod.files) {
      if (!existsSync(join(cachePath, file))) {
        return false;
      }
    }
  }
  return true;
}

function copyToCache(target) {
  console.log(`  Caching binaries for ${target}...`);
  for (const mod of NATIVE_MODULES) {
    const srcPath = findModulePath(mod.name);
    if (!srcPath) {
      console.warn(`  Warning: Could not find ${mod.name} build directory`);
      continue;
    }
    const cachePath = getCachePath(target, mod.name);
    mkdirSync(cachePath, { recursive: true });
    for (const file of mod.files) {
      const src = join(srcPath, file);
      const dst = join(cachePath, file);
      if (existsSync(src)) {
        cpSync(src, dst);
      }
    }
  }
}

function restoreFromCache(target) {
  console.log(`  Restoring binaries from cache...`);
  for (const mod of NATIVE_MODULES) {
    const dstPath = findModulePath(mod.name);
    if (!dstPath) {
      console.warn(`  Warning: Could not find ${mod.name} build directory`);
      continue;
    }
    const cachePath = getCachePath(target, mod.name);
    for (const file of mod.files) {
      const src = join(cachePath, file);
      const dst = join(dstPath, file);
      if (existsSync(src)) {
        cpSync(src, dst);
      }
    }
  }
}

function rebuild(target) {
  console.log(`  Rebuilding native modules for ${target}...`);
  if (target === 'electron') {
    execSync('pnpm exec electron-rebuild -f -m . -o better-sqlite3,node-pty', {
      cwd: ROOT,
      stdio: 'inherit',
    });
  } else {
    // Rebuild native modules for Node.js
    // Use pnpm rebuild which handles the pnpm structure correctly
    execSync('pnpm rebuild better-sqlite3 node-pty', {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
}

function main() {
  const target = process.argv[2];
  if (!target || !['node', 'electron'].includes(target)) {
    console.error('Usage: ensure-native-modules.mjs <node|electron>');
    process.exit(1);
  }

  const currentTarget = getCurrentTarget();

  if (currentTarget === target) {
    console.log(`Native modules already built for ${target}`);
    return;
  }

  console.log(`Switching native modules: ${currentTarget || 'unknown'} -> ${target}`);

  // Cache current binaries before switching (if we know what they are)
  if (currentTarget && !cacheExists(currentTarget)) {
    copyToCache(currentTarget);
  }

  // Either restore from cache or rebuild
  if (cacheExists(target)) {
    restoreFromCache(target);
  } else {
    rebuild(target);
    copyToCache(target);
  }

  setCurrentTarget(target);
  console.log(`Native modules ready for ${target}`);
}

main();
