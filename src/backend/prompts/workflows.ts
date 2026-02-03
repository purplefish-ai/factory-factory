/**
 * Workflow prompt loader.
 *
 * Workflows are defined by markdown files in prompts/workflows/.
 * Each file has YAML frontmatter with metadata (name, description, expectsPR).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createLogger } from '../services/logger.service';

const logger = createLogger('workflows');

// =============================================================================
// Types
// =============================================================================

export interface Workflow {
  /** Workflow ID (filename without .md extension) */
  id: string;
  /** Display name from frontmatter */
  name: string;
  /** Description from frontmatter */
  description: string;
  /** Whether this workflow typically results in a PR */
  expectsPR: boolean;
  /** The prompt content (markdown after frontmatter) */
  content: string;
}

// Path to workflows directory (relative to this file's location)
// From src/backend/prompts/ → src/backend → src → project root
const WORKFLOWS_DIR = resolve(import.meta.dirname, '../../..', 'prompts/workflows');

// =============================================================================
// Frontmatter Parser
// =============================================================================

interface Frontmatter {
  name?: string;
  description?: string;
  expectsPR?: boolean;
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
      case 'expectsPR':
        frontmatter.expectsPR = value === 'true';
        break;
    }
  }

  return { frontmatter, body };
}

// =============================================================================
// Workflow Loading
// =============================================================================

/**
 * Load a single workflow file.
 */
function loadWorkflowFile(filePath: string): Workflow | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const id = basename(filePath, '.md');
    const { frontmatter, body } = parseFrontmatter(content);

    return {
      id,
      name: frontmatter.name ?? id,
      description: frontmatter.description ?? '',
      expectsPR: frontmatter.expectsPR ?? false,
      content: body.trim(),
    };
  } catch {
    return null;
  }
}

// Cached workflows (loaded once at startup)
let cachedWorkflows: Workflow[] | null = null;

/**
 * Load all workflows from the workflows directory.
 * Results are cached after first call.
 */
function loadWorkflows(): Workflow[] {
  if (cachedWorkflows !== null) {
    logger.debug('Returning cached workflows', { count: cachedWorkflows.length });
    return cachedWorkflows;
  }

  logger.info('Loading workflows from disk', { dir: WORKFLOWS_DIR });

  try {
    const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.md'));
    logger.info('Found workflow files', { files });
    cachedWorkflows = files
      .map((file) => loadWorkflowFile(join(WORKFLOWS_DIR, file)))
      .filter((w): w is Workflow => w !== null);
    logger.info('Loaded workflows', {
      count: cachedWorkflows.length,
      ids: cachedWorkflows.map((w) => w.id),
    });
    return cachedWorkflows;
  } catch (error) {
    // Directory doesn't exist or can't be read
    logger.error('Failed to load workflows', { dir: WORKFLOWS_DIR, error: String(error) });
    cachedWorkflows = [];
    return cachedWorkflows;
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Get a workflow by ID.
 */
export function getWorkflow(id: string): Workflow | null {
  return loadWorkflows().find((w) => w.id === id) ?? null;
}

/**
 * Get workflow prompt content by ID.
 * Returns null if workflow not found.
 */
export function getWorkflowContent(id: string): string | null {
  return getWorkflow(id)?.content ?? null;
}
