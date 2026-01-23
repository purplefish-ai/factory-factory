import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface ClaudeAuthStatus {
  isInstalled: boolean;
  isAuthenticated: boolean;
  version?: string;
  credentialsPath?: string;
  errors: string[];
}

/**
 * Check if Claude Code CLI is installed and available in PATH
 */
export async function isClaudeCodeInstalled(): Promise<boolean> {
  try {
    // Try both 'claude' and 'claude-code' commands
    await execAsync('which claude || which claude-code');
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if user is authenticated with Claude Code (OAuth)
 * Looks for ~/.claude.json (the main Claude config/auth file)
 * This is where Claude Code stores authentication after `claude login`
 */
export function isClaudeAuthenticated(): boolean {
  const credentialsPath = path.join(os.homedir(), '.claude.json');
  return fs.existsSync(credentialsPath);
}

/**
 * Get Claude Code CLI version
 */
export async function getClaudeVersion(): Promise<string | null> {
  try {
    const { stdout } = await execAsync('claude --version 2>&1 || claude-code --version 2>&1');
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Get the path to Claude credentials file
 */
export function getCredentialsPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * Validate complete Claude Code setup
 * Returns detailed status for all checks
 */
export async function validateClaudeSetup(): Promise<ClaudeAuthStatus> {
  const status: ClaudeAuthStatus = {
    isInstalled: false,
    isAuthenticated: false,
    errors: [],
  };

  // Check installation
  status.isInstalled = await isClaudeCodeInstalled();
  if (!status.isInstalled) {
    status.errors.push(
      'Claude Code CLI is not installed or not in PATH. ' +
        'Please install it: npm install -g @anthropic-ai/claude-code'
    );
  }

  // Check authentication
  status.isAuthenticated = isClaudeAuthenticated();
  status.credentialsPath = getCredentialsPath();

  if (!status.isAuthenticated) {
    status.errors.push(
      `Claude Code is not authenticated. Credentials not found at: ${status.credentialsPath}. ` +
        'Please run: claude login'
    );
  }

  // Get version if installed
  if (status.isInstalled) {
    status.version = (await getClaudeVersion()) ?? undefined;
  }

  return status;
}

/**
 * Get helpful error message for authentication issues
 */
export function getAuthErrorMessage(status: ClaudeAuthStatus): string {
  if (status.errors.length === 0) {
    return '';
  }

  return [
    '❌ Claude Code Setup Issues:',
    '',
    ...status.errors.map((error, i) => `${i + 1}. ${error}`),
    '',
    'Please complete the setup before starting workers.',
  ].join('\n');
}

/**
 * Throw error if Claude Code is not properly set up
 * Use this at worker startup to validate prerequisites
 */
export async function requireClaudeSetup(): Promise<void> {
  const status = await validateClaudeSetup();

  if (!status.isInstalled || !status.isAuthenticated) {
    const errorMessage = getAuthErrorMessage(status);
    throw new Error(errorMessage);
  }
}
