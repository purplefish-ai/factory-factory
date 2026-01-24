/**
 * Supervisor agent prompt builder
 *
 * Composes markdown prompt files with dynamic sections to build the supervisor system prompt.
 */

import { PromptBuilder } from '../../../prompts/index.js';
import {
  generateContextFooter,
  generateCurlIntro,
  generateToolsSection,
  getMailToolsForAgent,
} from '../sections/index.js';
import type { SupervisorContext, ToolCategory } from '../types.js';

// Supervisor-specific tool definitions
const TASK_MANAGEMENT_TOOLS: ToolCategory = {
  name: 'Task Management',
  tools: [
    {
      name: 'mcp__task__create',
      description: 'Create a new subtask for a worker',
      inputExample: {
        title: 'Subtask title here',
        description: 'Detailed description of what the worker should implement',
      },
    },
    {
      name: 'mcp__task__list',
      description: 'List all subtasks for your top-level task',
      inputExample: {},
    },
  ],
};

const CODE_REVIEW_TOOLS: ToolCategory = {
  name: 'Code Review',
  tools: [
    {
      name: 'mcp__task__get_review_queue',
      description: 'Get subtasks ready for review ordered by submission time',
      inputExample: {},
    },
    {
      name: 'mcp__git__read_worktree_file',
      description: "Read a file from a worker's worktree for code review",
      inputExample: {
        taskId: 'task-id-here',
        filePath: 'src/path/to/file.ts',
      },
    },
    {
      name: 'mcp__task__approve',
      description: 'Approve subtask and merge worker branch into top-level task branch',
      inputExample: {
        taskId: 'task-id-here',
      },
    },
    {
      name: 'mcp__task__request_changes',
      description: 'Request changes from a worker',
      inputExample: {
        taskId: 'task-id-here',
        feedback: 'Please fix the following issues: ...',
      },
    },
  ],
};

const TASK_COMPLETION_TOOLS: ToolCategory = {
  name: 'Task Completion',
  tools: [
    {
      name: 'mcp__task__create_final_pr',
      description: 'Create PR from top-level task branch to main (for human review)',
      inputExample: {},
    },
  ],
};

/**
 * Build the complete supervisor system prompt
 */
export function buildSupervisorPrompt(context: SupervisorContext): string {
  // Build tools section with supervisor-specific tools
  const mailTools = getMailToolsForAgent('supervisor');
  const toolCategories: ToolCategory[] = [
    TASK_MANAGEMENT_TOOLS,
    CODE_REVIEW_TOOLS,
    TASK_COMPLETION_TOOLS,
    { name: 'Communication', tools: mailTools },
  ];

  // Build prompt from markdown files + dynamic sections
  const builder = new PromptBuilder()
    // Core supervisor identity and workflow
    .addFile('supervisor-role.md')
    .addFile('supervisor-planning.md')
    .addFile('supervisor-review.md')
    .addFile('supervisor-merge.md')
    .addFile('supervisor-escalation.md')
    .addFile('worker-management.md')
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

  // Add context footer with task assignment
  const additionalFields = [
    { label: 'Task ID', value: context.taskId },
    { label: 'Task Title', value: context.taskTitle },
    { label: 'Description', value: `\n${context.taskDescription}` },
    { label: 'Your Worktree', value: context.worktreePath },
    { label: 'Task Branch', value: context.taskBranchName },
  ];

  const closingMessage = `You are already in your top-level task worktree directory. Start by analyzing the task description above.

Then create subtasks using curl commands to the backend API.`;

  const footer = generateContextFooter(context, additionalFields, closingMessage);

  return prompt + footer;
}

// Re-export the context type for convenience
export type { SupervisorContext } from '../types.js';
