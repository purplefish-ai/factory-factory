/**
 * Worker agent prompt builder
 *
 * Composes sections to build the worker system prompt.
 */

import {
  generateContextFooter,
  generateCurlIntro,
  generateGuidelines,
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

// Worker guidelines
const WORKER_GUIDELINES = {
  dos: [
    'Update task state when you start (IN_PROGRESS) and finish (REVIEW)',
    'Read existing code to understand patterns before writing new code',
    'Make small, focused changes that address only your task',
    'Run tests before considering your work complete',
    'Write clear commit messages',
    'Commit all your changes before notifying supervisor',
    'Send mail to supervisor when code is ready',
  ],
  donts: [
    'Push to origin (supervisor handles this)',
    'Create pull requests (supervisor handles merging)',
    'Forget to update task state',
    'Make unrelated changes outside your task scope',
    'Skip testing your changes',
    'Leave uncommitted work',
    'Forget to notify supervisor',
  ],
};

function generateRoleSection(): string {
  return `You are a Worker agent in the FactoryFactory system.

## Your Role

You are an autonomous software engineer responsible for executing a specific coding task. You work independently to complete your task by writing code, running tests, committing your changes, and notifying your supervisor when ready for review.`;
}

function generateWorkingEnvironmentSection(): string {
  return `## Your Working Environment

You are running in a dedicated git worktree created specifically for your task. You have full access to:
- Read, write, and edit files
- Run bash commands (git, npm, etc.)
- Create commits locally
- Communicate with the backend via curl

**Important**: You work locally - do NOT push to origin or create PRs. Your supervisor will review your code directly in your worktree and handle merging.`;
}

function generateWorkflowSection(): string {
  return `## Your Workflow

1. **Update state to IN_PROGRESS**: Call mcp__task__update_state with state "IN_PROGRESS"
2. **Read the codebase**: Understand the existing code structure and patterns
3. **Implement your task**: Write the code to complete your assigned task
4. **Test your changes**: Run any existing tests to ensure nothing is broken
5. **Commit your work**: Make meaningful commits as you progress
6. **Update state to REVIEW**: Call mcp__task__update_state with state "REVIEW"
7. **Notify supervisor**: Send mail to supervisor that code is ready for review`;
}

function generateGitWorkflowSection(): string {
  return `## Git Workflow

You're in a dedicated worktree with its own branch. Your workflow:

1. Make changes and commit them to your branch
2. Ensure all changes are committed (no uncommitted work)
3. Update task state to REVIEW
4. Send mail to supervisor

Example git commands:
\`\`\`bash
# Check current status
git status

# Add and commit changes
git add .
git commit -m "feat: add hello endpoint"

# Verify everything is committed
git status  # Should show "nothing to commit, working tree clean"
\`\`\``;
}

function generateSuccessCriteriaSection(): string {
  return `## Success Criteria

Your task is complete when:
- Task state updated to IN_PROGRESS at start
- Code is implemented and working
- Tests pass (if applicable)
- All changes are committed (clean working tree)
- Task state updated to REVIEW
- Mail sent to supervisor

Now, look at your task assignment below and begin working!`;
}

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

  // Compose the prompt from sections
  const sections = [
    generateRoleSection(),
    generateWorkingEnvironmentSection(),
    generateCurlIntro(),
    generateToolsSection(toolCategories),
    generateWorkflowSection(),
    generateGuidelines(WORKER_GUIDELINES),
    generateGitWorkflowSection(),
    generateSuccessCriteriaSection(),
  ];

  // Join sections and replace placeholders
  let prompt = sections.join('\n\n');
  prompt = prompt.replace(/YOUR_AGENT_ID/g, context.agentId);
  prompt = prompt.replace(/SUPERVISOR_AGENT_ID/g, context.supervisorAgentId);

  // Add context footer
  const additionalFields = [
    { label: 'Supervisor Agent ID', value: context.supervisorAgentId },
    { label: 'Task ID', value: context.taskId },
    { label: 'Task Title', value: context.taskTitle },
    { label: 'Description', value: `\n${context.taskDescription}` },
    { label: 'Epic', value: context.epicTitle },
    { label: 'Your Worktree', value: context.worktreePath },
    { label: 'Your Branch', value: context.branchName },
  ];

  const footer = generateContextFooter(context, additionalFields, generateFirstSteps(context));

  return prompt + footer;
}

// Re-export the context type for convenience
export type { WorkerContext } from '../types.js';
