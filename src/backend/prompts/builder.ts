/**
 * PromptBuilder - Simple prompt composition from markdown files
 *
 * Loads markdown files and composes them with markdown separators.
 * Follows the multiclaude pattern of flat files + explicit composition.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Root of the project (where prompts/ directory lives)
const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const PROMPTS_DIR = resolve(PROJECT_ROOT, 'prompts');

export class PromptBuilder {
  private sections: string[] = [];

  /**
   * Add a markdown file from the prompts/ directory
   * @param filename - Filename without path (e.g., 'worker-role.md')
   */
  addFile(filename: string): this {
    const path = resolve(PROMPTS_DIR, filename);
    const content = readFileSync(path, 'utf-8').trim();
    this.sections.push(content);
    return this;
  }

  /**
   * Add raw content directly (for dynamic sections like context)
   */
  addRaw(content: string): this {
    this.sections.push(content.trim());
    return this;
  }

  /**
   * Build the final prompt with markdown separators
   */
  build(): string {
    return this.sections.join('\n\n---\n\n');
  }

  /**
   * Replace placeholders in the built prompt
   * @param replacements - Map of placeholder to value
   */
  static applyReplacements(prompt: string, replacements: Record<string, string>): string {
    let result = prompt;
    for (const [placeholder, value] of Object.entries(replacements)) {
      result = result.replace(new RegExp(placeholder, 'g'), value);
    }
    return result;
  }
}
