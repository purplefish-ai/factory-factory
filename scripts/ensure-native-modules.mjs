#!/usr/bin/env node
/**
 * Ensures ABI-specific native modules are compiled for the correct target.
 * Caches node-pty and legacy SQLite binaries for switching between Electron and Node.js.
 * better-sqlite3 v13+ uses N-API and shares its installed binary across both runtimes.
 *
 * Usage:
 *   node scripts/ensure-native-modules.mjs node      # For web/CLI development
 *   node scripts/ensure-native-modules.mjs electron  # For Electron development
 *   node scripts/ensure-native-modules.mjs electron --force  # Rebuild cached binaries
 */

import { execFileSync, execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE_DIR = join(ROOT, '.native-cache');
const MARKER_FILE = join(CACHE_DIR, '.current-target');

// Get Node.js ABI version (process.versions.modules gives the NODE_MODULE_VERSION)
const NODE_ABI_VERSION = process.versions.modules;
const packageVersionSchema = z.object({ version: z.string().regex(/^\d+\./) });

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

function getPrismaDriverPackage() {
  const adapterPath = realpathSync(join(ROOT, 'node_modules', '@prisma', 'adapter-better-sqlite3'));
  const adapterRequire = createRequire(join(adapterPath, 'package.json'));
  return adapterRequire.resolve('better-sqlite3/package.json');
}

function getAbiSpecificModules() {
  const require = createRequire(import.meta.url);
  const { version } = packageVersionSchema.parse(require(getPrismaDriverPackage()));
  // N-API SQLite binaries must never be overwritten by an older ABI-specific cache.
  return NATIVE_MODULES.filter(
    (mod) => mod.name !== 'better-sqlite3' || Number.parseInt(version, 10) < 13
  );
}

function findModulePath(moduleName) {
  if (moduleName === 'better-sqlite3') {
    return join(dirname(getPrismaDriverPackage()), 'build', 'Release');
  }
  // Find the module in pnpm's node_modules structure
  const pnpmDir = join(ROOT, 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) {
    return null;
  }

  const entries = readdirSync(pnpmDir);
  const match = entries.find((e) => e.startsWith(`${moduleName}@`));
  if (!match) {
    return null;
  }

  return join(pnpmDir, match, 'node_modules', moduleName, 'build', 'Release');
}

function getCurrentMarker() {
  if (!existsSync(MARKER_FILE)) {
    return null;
  }
  return readFileSync(MARKER_FILE, 'utf-8').trim();
}

function getMarkerValue(target) {
  // Include ABI version in marker for node target
  return getCacheKey(target);
}

function setCurrentMarker(target) {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
  writeFileSync(MARKER_FILE, getMarkerValue(target));
}

function getElectronVersion() {
  const packageJson = JSON.parse(
    readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf-8')
  );
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('Could not determine the installed Electron version');
  }
  return packageJson.version;
}

function getCacheKey(target) {
  // Native binaries are ABI-specific, so changing either runtime must invalidate the cache.
  if (target === 'node') {
    return `node-abi${NODE_ABI_VERSION}`;
  }
  return `electron-v${getElectronVersion()}`;
}

function getCachePath(target, moduleName) {
  return join(CACHE_DIR, getCacheKey(target), moduleName);
}

function cacheExists(target) {
  for (const mod of getAbiSpecificModules()) {
    const cachePath = getCachePath(target, mod.name);
    for (const file of mod.files) {
      if (!existsSync(join(cachePath, file))) {
        return false;
      }
    }
  }
  return true;
}

function cacheExistsForMarker(marker) {
  // Check if cache exists for a specific marker (e.g., 'node-abi127', 'electron')
  for (const mod of getAbiSpecificModules()) {
    const cachePath = join(CACHE_DIR, marker, mod.name);
    for (const file of mod.files) {
      if (!existsSync(join(cachePath, file))) {
        return false;
      }
    }
  }
  return true;
}

function copyToCacheWithMarker(marker) {
  // Cache current binaries under a specific marker path
  console.log(`  Caching binaries for ${marker}...`);
  for (const mod of getAbiSpecificModules()) {
    const srcPath = findModulePath(mod.name);
    if (!srcPath) {
      console.warn(`  Warning: Could not find ${mod.name} build directory`);
      continue;
    }
    const cachePath = join(CACHE_DIR, marker, mod.name);
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

function copyToCache(target) {
  console.log(`  Caching binaries for ${target}...`);
  for (const mod of getAbiSpecificModules()) {
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
  for (const mod of getAbiSpecificModules()) {
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
  const moduleNames = getAbiSpecificModules().map((mod) => mod.name);
  if (target === 'electron') {
    // Resolve once from this project. Running pnpm from an installed dependency
    // can trigger a separate install there instead of using our rebuild tool.
    const require = createRequire(import.meta.url);
    const rebuildCli = join(dirname(require.resolve('@electron/rebuild')), 'cli.js');
    execFileSync(process.execPath, [rebuildCli, '-f', '-m', '.', '-o', moduleNames.join(',')], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (moduleNames.includes('better-sqlite3')) {
      // Legacy Prisma drivers may live outside electron-rebuild's root dependency scan.
      const adapterPath = realpathSync(
        join(ROOT, 'node_modules', '@prisma', 'adapter-better-sqlite3')
      );
      execFileSync(process.execPath, [rebuildCli, '-f', '-m', '.', '-o', 'better-sqlite3'], {
        cwd: adapterPath,
        stdio: 'inherit',
      });
    }
  } else {
    // Rebuild native modules for Node.js
    // Use pnpm rebuild which handles the pnpm structure correctly
    execSync(`pnpm rebuild ${moduleNames.join(' ')}`, {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
}

function main() {
  const target = process.argv[2];
  const force = process.argv[3] === '--force';
  if (!target || !['node', 'electron'].includes(target)) {
    console.error('Usage: ensure-native-modules.mjs <node|electron> [--force]');
    process.exit(1);
  }

  const currentMarker = getCurrentMarker();
  const targetMarker = getMarkerValue(target);

  if (!force && currentMarker === targetMarker) {
    console.log(
      `Native modules already built for ${target}${target === 'node' ? ` (ABI ${NODE_ABI_VERSION})` : ''}`
    );
    return;
  }

  const displayCurrent = currentMarker || 'unknown';
  const displayTarget = target === 'node' ? `${target} (ABI ${NODE_ABI_VERSION})` : target;
  console.log(`Switching native modules: ${displayCurrent} -> ${displayTarget}`);

  // Cache current binaries before switching (if we know what they are)
  // Note: currentMarker includes ABI version for node, so we need to extract the base target
  if (currentMarker && !cacheExists(target)) {
    // Only cache if current binaries match the current marker's target type
    const currentIsNode = currentMarker.startsWith('node');
    const currentIsElectron =
      currentMarker === 'electron' || currentMarker.startsWith('electron-v');
    if ((currentIsNode || currentIsElectron) && !cacheExistsForMarker(currentMarker)) {
      copyToCacheWithMarker(currentMarker);
    }
  }

  // Either restore from cache or rebuild
  if (!force && cacheExists(target)) {
    restoreFromCache(target);
  } else {
    rebuild(target);
    copyToCache(target);
  }

  setCurrentMarker(target);
  console.log(
    `Native modules ready for ${target}${target === 'node' ? ` (ABI ${NODE_ABI_VERSION})` : ''}`
  );
}

main();
