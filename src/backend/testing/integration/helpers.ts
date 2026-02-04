/**
 * Helper utilities for integration tests.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Options for creating a temporary test repository.
 */
export interface TempRepoOptions {
  /** Files to create in the repo (path → content) */
  files?: Record<string, string>;
  /** Whether to initialize as a git repository (default: true) */
  gitInit?: boolean;
}

/**
 * Creates a temporary directory with optional files and git initialization.
 * Use this to create isolated test environments for Claude sessions.
 *
 * @example
 * ```typescript
 * const testDir = await createTempRepo({
 *   files: {
 *     'package.json': JSON.stringify({ name: 'test' }),
 *     'src/index.ts': 'console.log("hello");',
 *   },
 * });
 * ```
 */
export async function createTempRepo(options?: TempRepoOptions): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-integration-test-'));

  if (options?.gitInit !== false) {
    execSync('git init', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.email "test@example.com"', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.name "Integration Test"', { cwd: tempDir, stdio: 'pipe' });
  }

  if (options?.files) {
    for (const [filePath, content] of Object.entries(options.files)) {
      const fullPath = path.join(tempDir, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
    }

    if (options.gitInit !== false && Object.keys(options.files).length > 0) {
      execSync('git add .', { cwd: tempDir, stdio: 'pipe' });
      execSync('git commit -m "Initial commit"', { cwd: tempDir, stdio: 'pipe' });
    }
  }

  return tempDir;
}

/**
 * Cleans up a temporary test directory.
 */
export async function cleanupTempRepo(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors - the OS will clean up /tmp eventually
  }
}

/**
 * Waits for a condition to be true, polling at regular intervals.
 *
 * @param condition - Function that returns true when the condition is met
 * @param options - Timeout and polling interval options
 * @throws Error if the condition is not met within the timeout
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number; message?: string } = {}
): Promise<void> {
  const { timeout = 30_000, interval = 100, message = 'Condition not met' } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`${message} (timeout: ${timeout}ms)`);
}

/**
 * Reads a file from the test directory, returning null if it doesn't exist.
 */
export async function readTestFile(testDir: string, filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(testDir, filePath), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Checks if a file exists in the test directory.
 */
export async function fileExists(testDir: string, filePath: string): Promise<boolean> {
  try {
    await fs.access(path.join(testDir, filePath));
    return true;
  } catch {
    return false;
  }
}
