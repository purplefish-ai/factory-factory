/**
 * IDE Helper Functions
 *
 * This module provides utilities for detecting, configuring, and launching
 * various IDEs (Cursor, VS Code, custom commands) from workspace paths.
 */

import { execCommand } from './shell';

/**
 * IDE configurations for detection and launching
 */
export const IDE_CONFIGS: Record<
  string,
  {
    cliCommand: string;
    macAppName?: string;
    macBundleId?: string;
  }
> = {
  cursor: {
    cliCommand: 'cursor',
    macAppName: 'Cursor',
    macBundleId: 'com.todesktop.230313mzl4w4u92',
  },
  vscode: {
    cliCommand: 'code',
    macAppName: 'Visual Studio Code',
    macBundleId: 'com.microsoft.VSCode',
  },
};

/**
 * Check if an IDE is available on the system
 */
export async function checkIdeAvailable(ide: string): Promise<boolean> {
  const config = IDE_CONFIGS[ide];
  if (!config) {
    return false;
  }

  // Check if CLI is in PATH
  try {
    await execCommand('which', [config.cliCommand]);
    return true;
  } catch {
    // CLI not in PATH, check for macOS app
    if (process.platform === 'darwin' && config.macBundleId) {
      try {
        const result = await execCommand('mdfind', [
          `kMDItemCFBundleIdentifier == "${config.macBundleId}"`,
        ]);
        if (result.stdout.trim()) {
          return true;
        }
      } catch {
        // mdfind failed
      }
    }
    return false;
  }
}

/**
 * Execute a custom IDE command with path substitution
 */
export async function openCustomIde(customCommand: string, targetPath: string): Promise<boolean> {
  // Validate command doesn't contain shell metacharacters for security
  // Note: {} are allowed because they're used for the {workspace} placeholder
  if (/[;&|`$()[\]]/.test(customCommand)) {
    throw new Error('Custom command contains invalid characters');
  }

  // Always escape the workspace path for consistent parsing/unescaping
  const escapedPath = targetPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const quotedPath = targetPath.includes(' ') ? `"${escapedPath}"` : escapedPath;

  // Replace placeholders in custom command
  const command = customCommand.replace(/\{workspace\}/g, quotedPath);

  // Parse command and arguments - split on whitespace but preserve quoted strings
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  // Strip quotes then unescape backslashes that were escaped for parsing
  const cmd = parts[0]?.replace(/"/g, '').replace(/\\\\/g, '\\');
  const args = parts.slice(1).map((arg) => arg.replace(/"/g, '').replace(/\\\\/g, '\\'));

  if (!cmd) {
    return false;
  }

  try {
    await execCommand(cmd, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a built-in IDE using its CLI or macOS app
 */
export async function openBuiltInIde(ide: string, targetPath: string): Promise<boolean> {
  const config = IDE_CONFIGS[ide];
  if (!config) {
    return false;
  }

  // Try CLI command first
  try {
    await execCommand(config.cliCommand, [targetPath]);
    return true;
  } catch {
    // Fallback to 'open -a' on macOS
    if (process.platform === 'darwin' && config.macAppName) {
      try {
        await execCommand('open', ['-a', config.macAppName, targetPath]);
        return true;
      } catch {
        // Failed to open
      }
    }
    return false;
  }
}

/**
 * Open a path in the specified IDE
 * @param ide - IDE identifier ('cursor', 'vscode', or 'custom')
 * @param targetPath - Path to open
 * @param customCommand - Custom command for 'custom' IDE (supports {workspace} placeholder)
 */
export async function openPathInIde(
  ide: string,
  targetPath: string,
  customCommand?: string | null
): Promise<boolean> {
  if (ide === 'custom') {
    if (!customCommand) {
      return false;
    }
    return await openCustomIde(customCommand, targetPath);
  }

  return await openBuiltInIde(ide, targetPath);
}
