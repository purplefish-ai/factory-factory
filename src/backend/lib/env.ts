/**
 * Environment Variable Utilities
 *
 * Shared utilities for environment variable expansion and database path resolution.
 * Used by both runtime code (db.ts) and Prisma configuration (prisma.config.ts).
 */

import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Expand environment variables in a string.
 * Handles $VAR and ${VAR} syntax, including $USER.
 *
 * @example
 * expandEnvVars('$HOME/data') // '/Users/john/data'
 * expandEnvVars('${USER}') // 'john'
 */
export function expandEnvVars(value: string, depth = 0): string {
  // Prevent infinite recursion from circular env var references
  const MAX_DEPTH = 10;
  if (depth >= MAX_DEPTH) {
    return value;
  }

  // Replace $USER with actual home directory username (cross-platform)
  let result = value.replace(/\$USER|\$\{USER\}/g, basename(homedir()) || 'user');

  // Replace other environment variables
  result = result.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue !== undefined) {
      return expandEnvVars(envValue, depth + 1);
    }
    return match;
  });

  return result;
}

/**
 * Get the database file path based on environment.
 *
 * Priority:
 * 1. DATABASE_PATH environment variable (for Electron or explicit override)
 * 2. Default: ~/.factory-factory/data.db (development default)
 *
 * For Electron production, set DATABASE_PATH to app.getPath('userData')/data.db
 * before importing this module.
 */
export function getDatabasePath(): string {
  if (process.env.DATABASE_PATH) {
    return expandEnvVars(process.env.DATABASE_PATH);
  }

  // Default development path - expand any env vars in BASE_DIR (e.g., $USER)
  const rawBaseDir = process.env.BASE_DIR;
  const baseDir = rawBaseDir ? expandEnvVars(rawBaseDir) : join(homedir(), '.factory-factory');
  return join(baseDir, 'data.db');
}

/**
 * Get the database URL for Prisma (with file: prefix).
 *
 * This returns a SQLite connection URL suitable for Prisma configuration.
 */
export function getDatabaseUrl(): string {
  return `file:${getDatabasePath()}`;
}
