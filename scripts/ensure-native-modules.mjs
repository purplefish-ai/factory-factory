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

// Get Node.js ABI version (process.versions.modules gives the NODE_MODULE_VERSION)
const NODE_ABI_VERSION = process.versions.modules;

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

function getCacheKey(target) {
  // For Node.js, include the ABI version since binaries are version-specific
  // For Electron, electron-rebuild handles the correct Electron ABI
  if (target === 'node') {
    return `node-abi${NODE_ABI_VERSION}`;
  }
  return target;
}

function getCachePath(target, moduleName) {
  return join(CACHE_DIR, getCacheKey(target), moduleName);
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

function cacheExistsForMarker(marker) {
  // Check if cache exists for a specific marker (e.g., 'node-abi127', 'electron')
  for (const mod of NATIVE_MODULES) {
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
  for (const mod of NATIVE_MODULES) {
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

  const currentMarker = getCurrentMarker();
  const targetMarker = getMarkerValue(target);

  if (currentMarker === targetMarker) {
    console.log(`Native modules already built for ${target}${target === 'node' ? ` (ABI ${NODE_ABI_VERSION})` : ''}`);
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
    const currentIsElectron = currentMarker === 'electron';
    if ((currentIsNode || currentIsElectron) && !cacheExistsForMarker(currentMarker)) {
      copyToCacheWithMarker(currentMarker);
    }
  }

  // Either restore from cache or rebuild
  if (cacheExists(target)) {
    restoreFromCache(target);
  } else {
    rebuild(target);
    copyToCache(target);
  }

  setCurrentMarker(target);
  console.log(`Native modules ready for ${target}${target === 'node' ? ` (ABI ${NODE_ABI_VERSION})` : ''}`);
}

main();
