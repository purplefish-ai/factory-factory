/**
 * Prompt file manager for Claude Code CLI injection
 *
 * Centralizes all filesystem operations for prompt files.
 * Prompts are written to /tmp/ and injected via --append-system-prompt-file flag.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export class PromptFileManager {
  private readonly tempDir: string;
  private readonly prefix: string;

  constructor(options?: { tempDir?: string; prefix?: string }) {
    this.tempDir = options?.tempDir ?? os.tmpdir();
    this.prefix = options?.prefix ?? 'factoryfactory-prompt';
  }

  /**
   * Get the file path for an agent's prompt file
   */
  getPromptFilePath(agentId: string): string {
    return path.join(this.tempDir, `${this.prefix}-${agentId}.txt`);
  }

  /**
   * Write a prompt to a file for CLI injection
   * Returns the file path
   */
  writePromptFile(agentId: string, promptContent: string): string {
    const filePath = this.getPromptFilePath(agentId);
    fs.writeFileSync(filePath, promptContent, 'utf-8');
    return filePath;
  }

  /**
   * Check if a prompt file exists
   */
  promptFileExists(agentId: string): boolean {
    return fs.existsSync(this.getPromptFilePath(agentId));
  }

  /**
   * Delete a prompt file (cleanup)
   * Safe to call even if file doesn't exist
   */
  deletePromptFile(agentId: string): void {
    const filePath = this.getPromptFilePath(agentId);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // File may already be deleted or inaccessible
    }
  }

  /**
   * List all prompt files currently in temp directory
   */
  listPromptFiles(): string[] {
    try {
      const files = fs.readdirSync(this.tempDir);
      return files.filter((f) => f.startsWith(this.prefix)).map((f) => path.join(this.tempDir, f));
    } catch {
      return [];
    }
  }

  /**
   * Clean up all prompt files (useful for shutdown)
   */
  cleanupAllPromptFiles(): void {
    for (const filePath of this.listPromptFiles()) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // File may already be deleted
      }
    }
  }
}

// Singleton instance for consistent file management
export const promptFileManager = new PromptFileManager();
