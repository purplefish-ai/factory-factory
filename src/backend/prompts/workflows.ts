/**
 * Workflow prompt loader.
 *
 * Workflows are defined by markdown files in prompts/workflows/.
 * Each file has YAML frontmatter with metadata (name, description, expectsPR).
 */

import { resolve } from 'node:path';
import { createLogger } from '../services/logger.service';
import { createMarkdownLoader, parseFrontmatter } from './markdown-loader';

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

// =============================================================================
// Constants
// =============================================================================

/** Default workflow for first session in a workspace */
export const DEFAULT_FIRST_SESSION = 'feature';

/** Default workflow for subsequent sessions */
export const DEFAULT_FOLLOWUP = 'followup';

// Path to workflows directory (relative to this file's location)
// From src/backend/prompts/ → src/backend → src → project root
const WORKFLOWS_DIR = resolve(import.meta.dirname, '../../..', 'prompts/workflows');

// =============================================================================
// Frontmatter Parser
// =============================================================================

interface Frontmatter extends Record<string, unknown> {
  name?: string;
  description?: string;
  expectsPR?: boolean;
}

// =============================================================================
// Workflow Loading
// =============================================================================

/**
 * Parse a single workflow file.
 */
function parseWorkflowFile(_filePath: string, content: string, id: string): Workflow | null {
  const { frontmatter, body } = parseFrontmatter<Frontmatter>(content, {
    name: (v) => v,
    description: (v) => v,
    expectsPR: (v) => v === 'true',
  });

  return {
    id,
    name: frontmatter.name ?? id,
    description: frontmatter.description ?? '',
    expectsPR: frontmatter.expectsPR ?? false,
    content: body.trim(),
  };
}

// Create markdown loader instance
const workflowLoader = createMarkdownLoader<Workflow>({
  directory: WORKFLOWS_DIR,
  logger,
  parseFile: parseWorkflowFile,
});

// =============================================================================
// Public API
// =============================================================================

/**
 * List all available workflows.
 */
export function listWorkflows(): Workflow[] {
  return workflowLoader.load();
}

/**
 * Get a workflow by ID.
 */
export function getWorkflow(id: string): Workflow | null {
  return workflowLoader.load().find((w) => w.id === id) ?? null;
}

/**
 * Get workflow prompt content by ID.
 * Returns null if workflow not found.
 */
export function getWorkflowContent(id: string): string | null {
  return getWorkflow(id)?.content ?? null;
}

/**
 * Clear the workflow cache (useful for testing or hot reloading).
 */
export function clearWorkflowCache(): void {
  workflowLoader.clearCache();
}
