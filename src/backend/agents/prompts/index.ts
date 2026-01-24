/**
 * Centralized prompt management
 *
 * This module provides:
 * - Type-safe prompt builders for each agent type
 * - Composable prompt sections (curl patterns, guidelines, etc.)
 * - Prompt file management for Claude Code CLI injection
 */

// Builders
export {
  buildOrchestratorPrompt,
  buildSupervisorPrompt,
  buildWorkerPrompt,
} from './builders/index.js';

// File management
export { promptFileManager } from './file-manager.js';
// Sections (for advanced usage)
export {
  generateContextFooter,
  generateCurlIntro,
  generateGuidelines,
  generateToolsSection,
  getMailToolsForAgent,
} from './sections/index.js';
// Types
export type {
  AgentType,
  BaseAgentContext,
  ContextField,
  GuidelinesConfig,
  OrchestratorContext,
  SupervisorContext,
  ToolCategory,
  ToolDefinition,
  WorkerContext,
} from './types.js';
