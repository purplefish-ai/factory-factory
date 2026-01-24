/**
 * Worker agent prompt builder
 *
 * Composes markdown prompt files with dynamic sections to build the worker system prompt.
 */

import { PromptBuilder } from '../../../prompts/index.js';
import {
  generateContextFooter,
  generateCurlIntro,
  generateToolsSection,
  getMailToolsForAgent,
} from '../sections/index.js';
import type { ToolCategory, WorkerContext } from '../types.js';

// Worker-specific tool definitions
const TASK_TOOLS: ToolCategory = {
  name: 'Task Management',
  tools: [
    {
      name: 'mcp__task__update_state',
      description: 'Update your task state to IN_PROGRESS when starting work',
      inputExample: { state: 'IN_PROGRESS' },
    },
    {
      name: 'mcp__task__create_pr',
      description:
        'Submit your work for review. Creates PR, sets state to REVIEW, and notifies supervisor.',
      inputExample: {
        title: 'Add user authentication endpoint',
        description: 'Implemented JWT-based auth with login/logout endpoints.',
      },
    },
  ],
};

function generateFirstSteps(context: WorkerContext): string {
  return `## FIRST STEPS

1. Update your task state to IN_PROGRESS:
\`\`\`bash
curl -X POST ${context.backendUrl}/mcp/execute -H "Content-Type: application/json" -d '{"agentId": "${context.agentId}", "toolName": "mcp__task__update_state", "input": {"state": "IN_PROGRESS"}}'
\`\`\`

2. Explore the codebase and implement your task

## WHEN DONE

1. Commit all changes: \`git add . && git commit -m "your message"\`
2. Verify clean working tree: \`git status\`
3. Submit for review:
\`\`\`bash
curl -X POST ${context.backendUrl}/mcp/execute -H "Content-Type: application/json" -d '{"agentId": "${context.agentId}", "toolName": "mcp__task__create_pr", "input": {"title": "Brief title of what you built", "description": "Summary of implementation and any trade-offs."}}'
\`\`\`

This creates the PR, sets your state to REVIEW, and notifies your supervisor automatically.`;
}

/**
 * Build the complete worker system prompt
 */
export function buildWorkerPrompt(context: WorkerContext): string {
  // Build tools section with worker-specific tools
  const mailTools = getMailToolsForAgent('worker');
  const toolCategories: ToolCategory[] = [TASK_TOOLS, { name: 'Communication', tools: mailTools }];

  // Build prompt from markdown files + dynamic sections
  const builder = new PromptBuilder()
    // Core worker identity and workflow
    .addFile('worker-role.md')
    .addFile('worker-workflow.md')
    .addFile('worker-testing.md')
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
    SUPERVISOR_AGENT_ID: context.supervisorAgentId,
  });

  // Add context footer with task assignment
  const additionalFields = [
    { label: 'Supervisor Agent ID', value: context.supervisorAgentId },
    { label: 'Task ID', value: context.taskId },
    { label: 'Task Title', value: context.taskTitle },
    { label: 'Description', value: `\n${context.taskDescription}` },
    { label: 'Parent Task', value: context.parentTaskTitle },
    { label: 'Your Worktree', value: context.worktreePath },
    { label: 'Your Branch', value: context.branchName },
  ];

  const footer = generateContextFooter(context, additionalFields, generateFirstSteps(context));

  return prompt + footer;
}

// Re-export the context type for convenience
export type { WorkerContext } from '../types.js';
