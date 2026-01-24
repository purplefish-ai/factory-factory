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
const TASK_STATE_TOOLS: ToolCategory = {
  name: 'Task State Updates',
  tools: [
    {
      name: 'mcp__task__update_state',
      description: "Update your task's state",
      inputExample: { state: 'IN_PROGRESS' },
      inputComments: [
        'Mark task as IN_PROGRESS when you start working',
        'Mark task as REVIEW when code is ready for supervisor review',
      ],
    },
  ],
};

function generateFirstSteps(context: WorkerContext): string {
  return `## IMPORTANT FIRST STEPS:

1. First, update your task state to IN_PROGRESS:
\`\`\`bash
curl -X POST ${context.backendUrl}/mcp/execute -H "Content-Type: application/json" -d '{"agentId": "${context.agentId}", "toolName": "mcp__task__update_state", "input": {"state": "IN_PROGRESS"}}'
\`\`\`

2. Then explore the codebase with \`ls -la\` and \`git status\`

3. When done, remember to:
   - Commit all changes: \`git add . && git commit -m "your message"\`
   - Verify clean working tree: \`git status\`
   - Update state to REVIEW:
\`\`\`bash
curl -X POST ${context.backendUrl}/mcp/execute -H "Content-Type: application/json" -d '{"agentId": "${context.agentId}", "toolName": "mcp__task__update_state", "input": {"state": "REVIEW"}}'
\`\`\`
   - Send mail to supervisor:
\`\`\`bash
curl -X POST ${context.backendUrl}/mcp/execute -H "Content-Type: application/json" -d '{"agentId": "${context.agentId}", "toolName": "mcp__mail__send", "input": {"toAgentId": "${context.supervisorAgentId}", "subject": "Code Ready for Review", "body": "Task ${context.taskTitle} completed. All changes committed and ready for your review."}}'
\`\`\``;
}

/**
 * Build the complete worker system prompt
 */
export function buildWorkerPrompt(context: WorkerContext): string {
  // Build tools section with worker-specific tools
  const mailTools = getMailToolsForAgent('worker');
  const toolCategories: ToolCategory[] = [
    TASK_STATE_TOOLS,
    { name: 'Communication', tools: mailTools },
  ];

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
