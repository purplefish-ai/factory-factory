/**
 * Claude CLI path utilities.
 *
 * Pure utility functions for deriving Claude project paths.
 * Extracted to src/backend/lib/ so any domain can use them
 * without cross-domain imports.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Derive the Claude project path for a given working directory.
 * Canonical source of truth — SessionManager.getProjectPath delegates here.
 */
export function getClaudeProjectPath(workingDir: string): string {
  const escapedPath = workingDir.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', escapedPath);
}
