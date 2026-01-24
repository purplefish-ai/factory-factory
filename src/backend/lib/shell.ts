/**
 * Centralized Shell Execution Library
 *
 * This module provides safe shell execution patterns to prevent command injection.
 * All shell commands in the codebase should go through this module.
 *
 * SECURITY PRINCIPLES:
 * 1. Prefer execCommand() with array args - bypasses shell entirely
 * 2. Use escapeShellArg() for single-quote wrapping when shell is needed
 * 3. Validate untrusted inputs (branch names, paths, session names)
 * 4. Never use command substitution ($(), ``) with untrusted data
 */

import { exec, type SpawnOptions, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecShellOptions {
  cwd?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

// ============================================================================
// Escaping Functions
// ============================================================================

/**
 * Escape a string for safe use in shell commands.
 * Uses single-quote wrapping with embedded single-quote escaping.
 *
 * This is the safest escaping method - single quotes prevent all
 * shell interpretation except for the single quote character itself.
 *
 * @example
 * escapeShellArg("hello world") // "'hello world'"
 * escapeShellArg("it's here") // "'it'\\''s here'"
 * escapeShellArg("$(rm -rf /)") // "'$(rm -rf /)'" - safe!
 */
export function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Escape a string for use inside double quotes in bash.
 * Escapes: " ` $ \
 *
 * Use this when you need variable expansion or other double-quote features,
 * but be aware this is less safe than single-quote escaping.
 *
 * @example
 * escapeDoubleQuoted('say "hello"') // 'say \\"hello\\"'
 * escapeDoubleQuoted('cost is $100') // 'cost is \\$100'
 */
export function escapeDoubleQuoted(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

/**
 * Escape a string for AppleScript osascript commands.
 * Handles multiple escaping layers: shell -> AppleScript.
 */
export function escapeForOsascript(str: string): string {
  return str
    .replace(/[\r\n]+/g, ' ') // Normalize newlines
    .replace(/\\/g, '\\\\') // Escape backslashes for AppleScript
    .replace(/"/g, '\\"') // Escape double quotes for AppleScript
    .replace(/'/g, "'\\''") // Escape single quotes for shell
    .slice(0, 200); // Truncate to prevent buffer overflow
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate a git branch name.
 * Allows: alphanumeric, hyphens, underscores, slashes, dots
 */
export function isValidBranchName(name: string): boolean {
  // Git branch name rules (simplified):
  // - No spaces, ~, ^, :, ?, *, [, \, consecutive dots, leading/trailing dots/slashes
  return /^[\w][\w\-./]*$/.test(name) && !name.includes('..') && !name.endsWith('/');
}

/**
 * Validate a branch name and throw if invalid.
 */
export function validateBranchName(name: string): string {
  if (!isValidBranchName(name)) {
    throw new Error(`Invalid branch name: ${name}`);
  }
  return name;
}

/**
 * Validate a tmux session name.
 * Only allows: alphanumeric, underscores, hyphens
 */
export function isValidSessionName(name: string): boolean {
  return /^[\w-]+$/.test(name);
}

/**
 * Validate a session name and throw if invalid.
 */
export function validateSessionName(name: string): string {
  if (!isValidSessionName(name)) {
    throw new Error(`Invalid tmux session name: ${name}`);
  }
  return name;
}

/**
 * Validate a file path for safety.
 * Checks for: null bytes, command substitution
 */
export function isValidPath(path: string): boolean {
  return !(path.includes('\0') || path.includes('`') || path.includes('$('));
}

/**
 * Validate a path and throw if invalid.
 */
export function validatePath(path: string): string {
  if (!isValidPath(path)) {
    throw new Error(`Invalid path (contains unsafe characters): ${path}`);
  }
  return path;
}

// ============================================================================
// Execution Functions
// ============================================================================

/**
 * Execute a command safely using spawn with array arguments (PREFERRED).
 *
 * This bypasses the shell entirely, so no escaping is needed.
 * Use this for any command where you have discrete arguments.
 *
 * @example
 * await execCommand('git', ['commit', '-m', userMessage], { cwd: '/repo' });
 * await execCommand('mkdir', ['-p', '/path/with spaces/ok']);
 */
export function execCommand(
  command: string,
  args: string[],
  options?: SpawnOptions
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { ...options, shell: false });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (error) => {
      reject(new Error(`Failed to execute ${command}: ${error.message}`));
    });

    proc.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        code: code ?? 0,
      });
    });
  });
}

/**
 * Execute a shell command (use sparingly, prefer execCommand).
 *
 * Use this only when you need shell features like pipes, redirects,
 * or glob patterns. Be very careful with user input.
 *
 * @example
 * await execShell('ls -la | head -5', { cwd: '/tmp' });
 */
export async function execShell(
  command: string,
  options?: ExecShellOptions
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execAsync(command, {
    cwd: options?.cwd,
    timeout: options?.timeout,
    env: options?.env,
    maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024, // 10MB default
  });
  return { stdout, stderr };
}

// ============================================================================
// Git Helper Functions
// ============================================================================

/**
 * Execute a git command safely using spawn with array arguments.
 *
 * @example
 * await gitCommand(['commit', '-m', userMessage], '/repo/path');
 * await gitCommand(['worktree', 'add', '-b', branch, path, base], repoPath);
 */
export function gitCommand(args: string[], cwd: string): Promise<ExecResult> {
  return execCommand('git', args, { cwd });
}

/**
 * Execute a git command with -C flag (alternative to cwd option).
 *
 * @example
 * await gitCommandC(repoPath, ['status']);
 * await gitCommandC(repoPath, ['diff', '--stat', 'main...HEAD']);
 */
export function gitCommandC(repoPath: string, args: string[]): Promise<ExecResult> {
  return execCommand('git', ['-C', repoPath, ...args]);
}

// ============================================================================
// Tmux Helper Functions
// ============================================================================

/**
 * Execute a tmux command safely using spawn with array arguments.
 *
 * @example
 * await tmuxCommand(['has-session', '-t', sessionName]);
 * await tmuxCommand(['capture-pane', '-t', session, '-p']);
 */
export function tmuxCommand(args: string[], socketPath?: string): Promise<ExecResult> {
  const fullArgs = socketPath ? ['-S', socketPath, ...args] : args;
  return execCommand('tmux', fullArgs);
}

// ============================================================================
// Platform-specific Commands
// ============================================================================

/**
 * Send a macOS notification using osascript.
 */
export async function sendMacNotification(
  title: string,
  message: string,
  sound?: string
): Promise<void> {
  const escapedTitle = escapeForOsascript(title);
  const escapedMessage = escapeForOsascript(message);

  let script = `display notification "${escapedMessage}" with title "${escapedTitle}"`;
  if (sound) {
    script += ` sound name "${escapeForOsascript(sound)}"`;
  }

  await execShell(`osascript -e '${script}'`);
}

/**
 * Send a Linux notification using notify-send.
 */
export async function sendLinuxNotification(title: string, message: string): Promise<void> {
  await execCommand('notify-send', [title, message]);
}
