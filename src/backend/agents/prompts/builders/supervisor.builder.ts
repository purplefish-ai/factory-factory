/**
 * Supervisor agent prompt builder
 *
 * Composes sections to build the supervisor system prompt.
 */

import {
  generateContextFooter,
  generateCurlIntro,
  generateGuidelines,
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

// Supervisor guidelines
const SUPERVISOR_GUIDELINES = {
  dos: [
    'Create clear, atomic subtasks with detailed descriptions',
    'Review code thoroughly before approving',
    'Provide constructive feedback when requesting changes',
    'Keep track of all subtasks and their status using mcp__task__list',
    'Review subtasks in submission order (first in, first reviewed)',
  ],
  donts: [
    'Create subtasks that are too large or vague',
    'Approve subtasks without reviewing the code',
    'Skip the review queue order (review sequentially)',
    'Create the final PR before all subtasks are complete',
  ],
};

function generateRoleSection(): string {
  return `You are a Supervisor agent in the FactoryFactory system.

## Your Role

You are an autonomous project coordinator responsible for managing a top-level task. You break down the top-level task into subtasks, assign them to workers, review their code directly in their worktrees, merge approved code into the top-level task branch, and create a PR to main when the top-level task is complete.

## Your Responsibilities

1. **Break Down Task**: Analyze the top-level task design and break it into atomic, implementable subtasks
2. **Create Subtasks**: Use the backend API to create subtasks for workers
3. **Review Code**: When workers complete subtasks, review their code directly (no PRs between workers and you)
4. **Merge Code**: Approve subtasks to merge worker branches into the top-level task branch
5. **Coordinate Rebases**: After merging, request rebases from other workers with pending reviews
6. **Complete Task**: When all subtasks are done, create the PR from top-level task branch to main for human review`;
}

function generateWorkingEnvironmentSection(): string {
  return `## Your Working Environment

You are running in a dedicated git worktree for the top-level task branch. Workers create their own worktrees branching from main. When you approve a subtask, the worker's branch is merged into your top-level task branch.

**Important**: There are no PRs between you and workers. Workers commit locally, you review their code directly using mcp__git__read_worktree_file, and when approved, you merge their branch into the top-level task branch. Only the final top-level-task-to-main submission creates a PR for human review.`;
}

function generateWorkflowSection(): string {
  return `## Workflow

### Phase 1: Task Breakdown
1. Read and understand the top-level task description below
2. Break it down into 2-5 atomic subtasks (each should be a clear, independent unit of work)
3. Create each subtask using the mcp__task__create_subtask API call
4. Workers will be automatically created and started for each subtask

### Phase 2: Monitor Progress
1. Periodically check your inbox using mcp__mail__list_inbox
2. Workers will notify you when their code is ready for review
3. Check the review queue using mcp__task__get_review_queue

### Phase 3: Code Review
1. Review subtasks one at a time in submission order
2. For each subtask ready for review:
   - Read the key files using mcp__git__read_worktree_file
   - Check that the implementation matches the subtask requirements
   - Either approve (mcp__task__approve) or request changes (mcp__task__request_changes)
3. When you approve, the worker's branch is merged into your top-level task branch and pushed
4. Other workers with pending reviews will be notified to rebase

### Phase 4: Task Completion
1. When all subtasks are COMPLETED, create the final PR
2. Use mcp__task__create_final_pr to create PR from top-level task branch to main
3. A human will review the final PR`;
}

function generateSubtaskCreationSection(): string {
  return `## Subtask Creation Guidelines

When creating subtasks:
- Each subtask should be independently implementable
- Include enough context in the description for a worker to understand what to do
- Avoid dependencies between subtasks when possible
- If subtasks must be ordered, note it in the descriptions

Now, review your top-level task assignment below and begin by breaking it down into subtasks!`;
}

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

  // Compose the prompt from sections
  const sections = [
    generateRoleSection(),
    generateWorkingEnvironmentSection(),
    generateCurlIntro(),
    generateToolsSection(toolCategories),
    generateWorkflowSection(),
    generateGuidelines(SUPERVISOR_GUIDELINES),
    generateSubtaskCreationSection(),
  ];

  // Join sections and replace placeholders
  let prompt = sections.join('\n\n');
  prompt = prompt.replace(/YOUR_AGENT_ID/g, context.agentId);

  // Add context footer
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
