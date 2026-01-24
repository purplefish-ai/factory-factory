/**
 * Orchestrator agent prompt builder
 *
 * Composes markdown prompt files with dynamic sections to build the orchestrator system prompt.
 */

import { PromptBuilder } from '../../../prompts/index.js';
import {
  generateContextFooter,
  generateCurlIntro,
  generateToolsSection,
  getMailToolsForAgent,
} from '../sections/index.js';
import type { OrchestratorContext, ToolCategory } from '../types.js';

// Orchestrator-specific tool definitions
const SUPERVISOR_MANAGEMENT_TOOLS: ToolCategory = {
  name: 'Supervisor Management',
  tools: [
    {
      name: 'mcp__orchestrator__list_supervisors',
      description: 'List all supervisors with health status',
      inputExample: {},
    },
    {
      name: 'mcp__orchestrator__check_supervisor_health',
      description: 'Check health of a specific supervisor',
      inputExample: {
        supervisorId: 'supervisor-agent-id',
      },
    },
    {
      name: 'mcp__orchestrator__create_supervisor',
      description: 'Create a new supervisor for a top-level task',
      inputExample: {
        taskId: 'task-id-here',
      },
    },
    {
      name: 'mcp__orchestrator__recover_supervisor',
      description: 'Trigger cascading recovery for crashed supervisor',
      inputExample: {
        supervisorId: 'supervisor-agent-id',
      },
    },
  ],
};

const TASK_MANAGEMENT_TOOLS: ToolCategory = {
  name: 'Task Management',
  tools: [
    {
      name: 'mcp__task__list_pending',
      description: 'List top-level tasks that need supervisors',
      inputExample: {},
    },
  ],
};

/**
 * Build the complete orchestrator system prompt
 */
export function buildOrchestratorPrompt(context: OrchestratorContext): string {
  // Build tools section with orchestrator-specific tools
  const mailTools = getMailToolsForAgent('orchestrator');
  const toolCategories: ToolCategory[] = [
    SUPERVISOR_MANAGEMENT_TOOLS,
    TASK_MANAGEMENT_TOOLS,
    { name: 'Communication', tools: mailTools },
  ];

  // Build prompt from markdown files + dynamic sections
  const builder = new PromptBuilder()
    // Core orchestrator identity (includes workflow, health checks, recovery)
    .addFile('orchestrator-role.md')
    // Shared behaviors (injected into all agents)
    .addFile('self-verification.md')
    .addFile('stuck-detection.md')
    // Dynamic sections
    .addRaw(generateCurlIntro())
    .addRaw(generateToolsSection(toolCategories));

  // Build and apply placeholders
  let prompt = builder.build();
  prompt = PromptBuilder.applyReplacements(prompt, {
    YOUR_AGENT_ID: context.agentId,
  });

  // Add context footer (orchestrator has minimal additional context)
  const closingMessage = `You are the Orchestrator. Begin by checking for any pending top-level tasks that need supervisors, then start monitoring supervisor health.`;

  const footer = generateContextFooter(context, [], closingMessage);

  return prompt + footer;
}

// Re-export the context type for convenience
export type { OrchestratorContext } from '../types.js';
