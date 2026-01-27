/**
 * Quick action loader.
 *
 * Quick actions are defined by markdown files in prompts/quick-actions/.
 * Each file has YAML frontmatter with metadata (name, description, type, icon, script).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createLogger } from '../services/logger.service';

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

interface Frontmatter {
  name?: string;
  description?: string;
  type?: string;
  icon?: string;
  script?: string;
}

/**
 * Parse simple YAML frontmatter from markdown content.
 * Only handles basic key: value pairs, not nested structures.
 */
function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterText = match[1];
  const body = content.slice(match[0].length);
  const frontmatter: Frontmatter = {};

  // Parse each line as key: value
  for (const line of frontmatterText.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    switch (key) {
      case 'name':
        frontmatter.name = value;
        break;
      case 'description':
        frontmatter.description = value;
        break;
      case 'type':
        frontmatter.type = value;
        break;
      case 'icon':
        frontmatter.icon = value;
        break;
      case 'script':
        frontmatter.script = value;
        break;
    }
  }

  return { frontmatter, body };
}

// =============================================================================
// Quick Action Loading
// =============================================================================

/**
 * Load a single quick action file.
 */
function loadQuickActionFile(filePath: string): QuickAction | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const id = basename(filePath, '.md');
    const { frontmatter, body } = parseFrontmatter(content);

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
  } catch (error) {
    logger.warn('Failed to load quick action file', { filePath, error: String(error) });
    return null;
  }
}

// Cached quick actions (loaded once at startup)
let cachedQuickActions: QuickAction[] | null = null;

/**
 * Load all quick actions from the quick-actions directory.
 * Results are cached after first call.
 */
function loadQuickActions(): QuickAction[] {
  if (cachedQuickActions !== null) {
    logger.debug('Returning cached quick actions', { count: cachedQuickActions.length });
    return cachedQuickActions;
  }

  logger.info('Loading quick actions from disk', { dir: QUICK_ACTIONS_DIR });

  try {
    const files = readdirSync(QUICK_ACTIONS_DIR).filter((f) => f.endsWith('.md'));
    logger.info('Found quick action files', { files });
    cachedQuickActions = files
      .map((file) => loadQuickActionFile(join(QUICK_ACTIONS_DIR, file)))
      .filter((a): a is QuickAction => a !== null);
    logger.info('Loaded quick actions', {
      count: cachedQuickActions.length,
      ids: cachedQuickActions.map((a) => a.id),
    });
    return cachedQuickActions;
  } catch (error) {
    // Directory doesn't exist or can't be read
    logger.error('Failed to load quick actions', { dir: QUICK_ACTIONS_DIR, error: String(error) });
    cachedQuickActions = [];
    return cachedQuickActions;
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * List all available quick actions.
 */
export function listQuickActions(): QuickAction[] {
  return loadQuickActions();
}

/**
 * Get a quick action by ID.
 */
export function getQuickAction(id: string): QuickAction | null {
  return loadQuickActions().find((a) => a.id === id) ?? null;
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
  cachedQuickActions = null;
}
