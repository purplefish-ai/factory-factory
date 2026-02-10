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
 * Mirrors SessionManager.getProjectPath but lives outside any domain.
 */
export function getClaudeProjectPath(workingDir: string): string {
  const escapedPath = workingDir.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', escapedPath);
}
