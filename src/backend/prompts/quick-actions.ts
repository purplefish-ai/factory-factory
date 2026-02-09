/**
 * Quick action loader.
 *
 * Quick actions are defined by markdown files in prompts/quick-actions/.
 * Each file has YAML frontmatter with metadata (name, description, type, icon, script).
 */

import { resolve } from 'node:path';
import { createLogger } from '../services/logger.service';
import { createMarkdownLoader, parseFrontmatter } from './markdown-loader';

const logger = createLogger('quick-actions');

// =============================================================================
// Types
// =============================================================================

export type QuickActionType = 'script' | 'agent';

export interface QuickAction {
  /** Action ID (filename without .md extension) */
  id: string;
  /** Display name from frontmatter */
  name: string;
  /** Description from frontmatter */
  description: string;
  /** Type of action: 'script' runs a command, 'agent' creates a Claude session */
  type: QuickActionType;
  /** Lucide icon name (optional) */
  icon?: string;
  /** For script actions: the command to run */
  script?: string;
  /** For agent actions: the prompt content (markdown after frontmatter) */
  content?: string;
}

// =============================================================================
// Constants
// =============================================================================

// Path to quick-actions directory (relative to this file's location)
// From src/backend/prompts/ → src/backend → src → project root
const QUICK_ACTIONS_DIR = resolve(import.meta.dirname, '../../..', 'prompts/quick-actions');

// =============================================================================
// Frontmatter Parser
// =============================================================================

interface Frontmatter extends Record<string, unknown> {
  name?: string;
  description?: string;
  type?: string;
  icon?: string;
  script?: string;
}

// =============================================================================
// Quick Action Loading
// =============================================================================

/**
 * Parse a single quick action file.
 */
function parseQuickActionFile(filePath: string, content: string, id: string): QuickAction | null {
  const { frontmatter, body } = parseFrontmatter<Frontmatter>(content, {
    name: (v) => v,
    description: (v) => v,
    type: (v) => v,
    icon: (v) => v,
    script: (v) => v,
  });

  // Validate and default the type
  let type: QuickActionType = 'agent';
  if (frontmatter.type === 'script') {
    type = 'script';
  } else if (frontmatter.type && frontmatter.type !== 'agent') {
    logger.warn('Unknown quick action type, defaulting to agent', {
      filePath,
      type: frontmatter.type,
    });
  }

  return {
    id,
    name: frontmatter.name ?? id,
    description: frontmatter.description ?? '',
    type,
    icon: frontmatter.icon,
    script: type === 'script' ? frontmatter.script : undefined,
    content: type === 'agent' ? body.trim() : undefined,
  };
}

// Create markdown loader instance
const quickActionLoader = createMarkdownLoader<QuickAction>({
  directory: QUICK_ACTIONS_DIR,
  logger,
  parseFile: parseQuickActionFile,
});

// =============================================================================
// Public API
// =============================================================================

/**
 * List all available quick actions.
 */
export function listQuickActions(): QuickAction[] {
  return quickActionLoader.load();
}

/**
 * Get a quick action by ID.
 */
export function getQuickAction(id: string): QuickAction | null {
  return quickActionLoader.load().find((a) => a.id === id) ?? null;
}

/**
 * Get quick action prompt content by ID.
 * Returns null if action not found or is a script action.
 */
export function getQuickActionContent(id: string): string | null {
  return getQuickAction(id)?.content ?? null;
}

/**
 * Clear the quick action cache (useful for testing or hot reloading).
 */
export function clearQuickActionCache(): void {
  quickActionLoader.clearCache();
}
