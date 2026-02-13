/**
 * Test fixture factories for Claude CLI message types.
 *
 * This file provides factory functions for creating realistic test data
 * for Storybook stories and unit tests. All factories produce properly
 * typed messages that match the Claude CLI streaming protocol.
 */

import type {
  AgentMetadata,
  AskUserQuestion,
  ChatMessage,
  ClaudeMessage,
  ClaudeStreamEvent,
  PermissionRequest,
  SessionInfo,
  TokenStats,
  ToolDefinition,
  ToolResultContent,
  ToolUseContent,
} from './chat-protocol';

// =============================================================================
// ID Generation
// =============================================================================

let messageIdCounter = 0;
let toolUseIdCounter = 0;

/**
 * Generates a unique message ID.
 */
function generateMessageId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`;
}

/**
 * Generates a unique tool use ID.
 */
function generateToolUseId(): string {
  return `toolu_${++toolUseIdCounter}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Generates a unique request ID.
 */
function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Generates an ISO timestamp.
 */
function generateTimestamp(): string {
  return new Date().toISOString();
}

// =============================================================================
// Sample Data Constants
// =============================================================================

export const SAMPLE_FILE_PATHS = {
  typescript: '/Users/developer/project/src/components/Button.tsx',
  javascript: '/Users/developer/project/src/utils/helpers.js',
  json: '/Users/developer/project/package.json',
  markdown: '/Users/developer/project/README.md',
  python: '/Users/developer/project/scripts/deploy.py',
  css: '/Users/developer/project/src/styles/main.css',
  config: '/Users/developer/project/tsconfig.json',
};

export const SAMPLE_FILE_CONTENTS = {
  typescript: `import React from 'react';

interface ButtonProps {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
}

export function Button({ label, onClick, variant = 'primary' }: ButtonProps) {
  return (
    <button
      className={\`btn btn-\${variant}\`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}`,
  json: `{
  "name": "my-project",
  "version": "1.0.0",
  "dependencies": {
    "react": "^18.2.0",
    "typescript": "^5.0.0"
  }
}`,
  markdown: `# My Project

A sample project for testing purposes.

## Installation

\`\`\`bash
npm install
\`\`\`
`,
};

export const SAMPLE_BASH_COMMANDS = {
  gitStatus: 'git status',
  npmInstall: 'npm install',
  npmTest: 'npm test',
  lsFiles: 'ls -la src/',
  findFiles: 'find . -name "*.ts" -type f',
};

export const SAMPLE_BASH_OUTPUTS = {
  gitStatus: `On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)

        modified:   src/components/Button.tsx

no changes added to commit (use "git add" and/or "git commit -a")`,
  npmInstall: `added 1234 packages, and audited 1235 packages in 12s

234 packages are looking for funding
  run \`npm fund\` for details

found 0 vulnerabilities`,
  npmTest: `PASS  src/components/Button.test.tsx
  Button Component
    ✓ renders with label (15 ms)
    ✓ calls onClick when clicked (8 ms)
    ✓ applies correct variant class (3 ms)

Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        2.345 s`,
};

// =============================================================================
// Message Factories
// =============================================================================

/** Counter for generating unique order values in fixtures */
let fixtureOrderCounter = 0;

/**
 * Creates a user chat message.
 */
export function createUserMessage(text: string, order?: number): ChatMessage {
  return {
    id: generateMessageId(),
    source: 'user',
    text,
    timestamp: generateTimestamp(),
    order: order ?? fixtureOrderCounter++,
  };
}

/**
 * Creates an assistant chat message with text content.
 */
export function createAssistantMessage(text: string, order?: number): ChatMessage {
  const claudeMessage: ClaudeMessage = {
    type: 'assistant',
    timestamp: generateTimestamp(),
    message: {
      role: 'assistant',
      content: text,
    },
  };

  return {
    id: generateMessageId(),
    source: 'claude',
    message: claudeMessage,
    timestamp: generateTimestamp(),
    order: order ?? fixtureOrderCounter++,
  };
}

/**
 * Creates a tool use chat message.
 */
export function createToolUseMessage(
  toolName: string,
  input: Record<string, unknown>,
  order?: number
): ChatMessage {
  const toolUseId = generateToolUseId();
  const toolUseContent: ToolUseContent = {
    type: 'tool_use',
    id: toolUseId,
    name: toolName,
    input,
  };

  const event: ClaudeStreamEvent = {
    type: 'content_block_start',
    index: 0,
    content_block: toolUseContent,
  };

  const claudeMessage: ClaudeMessage = {
    type: 'stream_event',
    timestamp: generateTimestamp(),
    event,
  };

  return {
    id: generateMessageId(),
    source: 'claude',
    message: claudeMessage,
    timestamp: generateTimestamp(),
    order: order ?? fixtureOrderCounter++,
  };
}

/**
 * Creates a tool result chat message.
 */
export function createToolResultMessage(
  toolUseId: string,
  content: string,
  isError = false,
  order?: number
): ChatMessage {
  const toolResultContent: ToolResultContent = {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: isError,
  };

  const event: ClaudeStreamEvent = {
    type: 'content_block_start',
    index: 0,
    content_block: toolResultContent,
  };

  const claudeMessage: ClaudeMessage = {
    type: 'stream_event',
    timestamp: generateTimestamp(),
    event,
  };

  return {
    id: generateMessageId(),
    source: 'claude',
    message: claudeMessage,
    timestamp: generateTimestamp(),
    order: order ?? fixtureOrderCounter++,
  };
}

/**
 * Creates a stream event chat message.
 */
export function createStreamEventMessage(event: ClaudeStreamEvent, order?: number): ChatMessage {
  const claudeMessage: ClaudeMessage = {
    type: 'stream_event',
    timestamp: generateTimestamp(),
    event,
  };

  return {
    id: generateMessageId(),
    source: 'claude',
    message: claudeMessage,
    timestamp: generateTimestamp(),
    order: order ?? fixtureOrderCounter++,
  };
}

/**
 * Creates a result chat message with token stats.
 */
export function createResultMessage(stats: Partial<TokenStats> = {}, order?: number): ChatMessage {
  const fullStats = createTokenStats(stats);

  const claudeMessage: ClaudeMessage = {
    type: 'result',
    timestamp: generateTimestamp(),
    usage: {
      input_tokens: fullStats.inputTokens,
      output_tokens: fullStats.outputTokens,
    },
    duration_ms: fullStats.totalDurationMs,
    total_cost_usd: fullStats.totalCostUsd,
    num_turns: fullStats.turnCount,
  };

  return {
    id: generateMessageId(),
    source: 'claude',
    message: claudeMessage,
    timestamp: generateTimestamp(),
    order: order ?? fixtureOrderCounter++,
  };
}

/**
 * Creates an error chat message.
 */
export function createErrorMessage(error: string, order?: number): ChatMessage {
  const claudeMessage: ClaudeMessage = {
    type: 'error',
    timestamp: generateTimestamp(),
    error,
    is_error: true,
  };

  return {
    id: generateMessageId(),
    source: 'claude',
    message: claudeMessage,
    timestamp: generateTimestamp(),
    order: order ?? fixtureOrderCounter++,
  };
}

/**
 * Creates a thinking content chat message.
 */
export function createThinkingMessage(thinking: string, order?: number): ChatMessage {
  const event: ClaudeStreamEvent = {
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'thinking',
      thinking,
    },
  };

  const claudeMessage: ClaudeMessage = {
    type: 'stream_event',
    timestamp: generateTimestamp(),
    event,
  };

  return {
    id: generateMessageId(),
    source: 'claude',
    message: claudeMessage,
    timestamp: generateTimestamp(),
    order: order ?? fixtureOrderCounter++,
  };
}

/**
 * Creates a system init chat message.
 */
export function createSystemMessage(
  model: string,
  tools?: ToolDefinition[],
  order?: number
): ChatMessage {
  const claudeMessage: ClaudeMessage = {
    type: 'system',
    timestamp: generateTimestamp(),
    subtype: 'init',
    model,
    tools: tools ?? createDefaultTools(),
    cwd: '/Users/developer/project',
    apiKeySource: 'environment',
  };

  return {
    id: generateMessageId(),
    source: 'claude',
    message: claudeMessage,
    timestamp: generateTimestamp(),
    order: order ?? fixtureOrderCounter++,
  };
}

// =============================================================================
// Permission/Question Factories
// =============================================================================

/**
 * Creates a permission request for tool approval.
 */
export function createPermissionRequest(
  toolName: string,
  input: Record<string, unknown>
): PermissionRequest {
  return {
    requestId: generateRequestId(),
    toolName,
    toolInput: input,
    timestamp: generateTimestamp(),
  };
}

/**
 * Creates a user question request.
 */
export function createUserQuestion(questions: AskUserQuestion[]): UserQuestionRequest {
  return {
    requestId: generateRequestId(),
    questions,
    timestamp: generateTimestamp(),
  };
}

// Import the type to avoid implicit any
interface UserQuestionRequest {
  requestId: string;
  questions: AskUserQuestion[];
  timestamp: string;
}

/**
 * Default plan content for stories and tests.
 */
export const DEFAULT_PLAN_CONTENT = `# Implementation Plan

## Summary
This plan outlines the steps to implement the requested feature.

## Steps
1. Create the initial component structure
2. Add unit tests
3. Update documentation

## Notes
- All changes will be tested before committing
- Code follows existing project patterns`;

/**
 * Creates a plan approval permission request.
 * Used when the agent is in plan mode and needs user approval.
 *
 * Uses SDK format with inline `plan` content (not file path).
 */
export function createPlanApprovalRequest(planContent = DEFAULT_PLAN_CONTENT): PermissionRequest {
  return {
    requestId: generateRequestId(),
    toolName: 'ExitPlanMode',
    toolInput: {
      plan: planContent,
      allowedPrompts: [
        { tool: 'Bash', prompt: 'run tests' },
        { tool: 'Bash', prompt: 'install dependencies' },
      ],
    },
    timestamp: generateTimestamp(),
    planContent,
  };
}

// =============================================================================
// Stats Factories
// =============================================================================

/**
 * Creates token stats with optional overrides.
 */
export function createTokenStats(overrides: Partial<TokenStats> = {}): TokenStats {
  return {
    inputTokens: overrides.inputTokens ?? 1500,
    outputTokens: overrides.outputTokens ?? 850,
    cacheReadInputTokens: overrides.cacheReadInputTokens ?? 800,
    cacheCreationInputTokens: overrides.cacheCreationInputTokens ?? 200,
    totalCostUsd: overrides.totalCostUsd ?? 0.0125,
    totalDurationMs: overrides.totalDurationMs ?? 3500,
    totalDurationApiMs: overrides.totalDurationApiMs ?? 2800,
    turnCount: overrides.turnCount ?? 3,
    webSearchRequests: overrides.webSearchRequests ?? 0,
    contextWindow: overrides.contextWindow === undefined ? 200_000 : overrides.contextWindow,
    maxOutputTokens: overrides.maxOutputTokens ?? 16_384,
    serviceTier: overrides.serviceTier ?? null,
  };
}

/**
 * Creates agent metadata with optional overrides.
 */
export function createAgentMetadata(overrides: Partial<AgentMetadata> = {}): AgentMetadata {
  const id = overrides.id ?? `agent-${Date.now()}`;
  return {
    id,
    type: overrides.type ?? 'WORKER',
    executionState: overrides.executionState ?? 'RUNNING',
    desiredExecutionState: overrides.desiredExecutionState ?? 'RUNNING',
    worktreePath: overrides.worktreePath ?? '/tmp/worktrees/project-worker-1',
    dbSessionId: overrides.dbSessionId ?? `session-${id}`,
    tmuxSessionName: overrides.tmuxSessionName ?? null,
    cliProcessId: overrides.cliProcessId ?? `cli-${id}`,
    cliProcessStatus: overrides.cliProcessStatus ?? 'RUNNING',
    isHealthy: overrides.isHealthy ?? true,
    minutesSinceHeartbeat: overrides.minutesSinceHeartbeat ?? 0,
    currentTask: overrides.currentTask ?? {
      id: 'task-123',
      title: 'Implement user authentication',
      state: 'IN_PROGRESS',
      branchName: 'feature/user-auth',
      prUrl: null,
    },
    assignedTasks: overrides.assignedTasks ?? [],
  };
}

/**
 * Creates session info with optional overrides.
 */
export function createSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const now = new Date();
  return {
    claudeSessionId: overrides.claudeSessionId ?? `session-${Date.now()}`,
    createdAt: overrides.createdAt ?? now.toISOString(),
    modifiedAt: overrides.modifiedAt ?? now.toISOString(),
    sizeBytes: overrides.sizeBytes ?? 15_360,
  };
}

// =============================================================================
// Tool Definition Helpers
// =============================================================================

/**
 * Creates a default set of tool definitions.
 */
export function createDefaultTools(): ToolDefinition[] {
  return [
    {
      name: 'Read',
      description: 'Read the contents of a file',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The path to the file to read' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'Write',
      description: 'Write content to a file',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The path to the file to write' },
          content: { type: 'string', description: 'The content to write' },
        },
        required: ['file_path', 'content'],
      },
    },
    {
      name: 'Edit',
      description: 'Edit a file by replacing text',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The path to the file to edit' },
          old_string: { type: 'string', description: 'The text to replace' },
          new_string: { type: 'string', description: 'The replacement text' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
    {
      name: 'Bash',
      description: 'Execute a bash command',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute' },
          description: { type: 'string', description: 'Description of what the command does' },
        },
        required: ['command'],
      },
    },
    {
      name: 'Glob',
      description: 'Find files matching a pattern',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The glob pattern to match' },
          path: { type: 'string', description: 'The directory to search in' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'Grep',
      description: 'Search for text in files',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The regex pattern to search for' },
          path: { type: 'string', description: 'The file or directory to search' },
          glob: { type: 'string', description: 'File pattern to filter' },
        },
        required: ['pattern'],
      },
    },
  ];
}

// =============================================================================
// Tool-Specific Message Factories
// =============================================================================

/**
 * Creates a Read tool use message.
 */
export function createReadToolUse(filePath: string = SAMPLE_FILE_PATHS.typescript): ChatMessage {
  return createToolUseMessage('Read', { file_path: filePath });
}

/**
 * Creates a Write tool use message.
 */
export function createWriteToolUse(
  filePath: string = SAMPLE_FILE_PATHS.typescript,
  content: string = SAMPLE_FILE_CONTENTS.typescript
): ChatMessage {
  return createToolUseMessage('Write', { file_path: filePath, content });
}

/**
 * Creates an Edit tool use message.
 */
export function createEditToolUse(
  filePath: string = SAMPLE_FILE_PATHS.typescript,
  oldString = 'const',
  newString = 'let'
): ChatMessage {
  return createToolUseMessage('Edit', {
    file_path: filePath,
    old_string: oldString,
    new_string: newString,
  });
}

/**
 * Creates a Bash tool use message.
 */
export function createBashToolUse(
  command: string = SAMPLE_BASH_COMMANDS.gitStatus,
  description = 'Check git status'
): ChatMessage {
  return createToolUseMessage('Bash', { command, description });
}

/**
 * Creates a Glob tool use message.
 */
export function createGlobToolUse(
  pattern = '**/*.ts',
  path = '/Users/developer/project'
): ChatMessage {
  return createToolUseMessage('Glob', { pattern, path });
}

/**
 * Creates a Grep tool use message.
 */
export function createGrepToolUse(
  searchPattern = 'export function',
  path = '/Users/developer/project/src',
  glob = '*.ts'
): ChatMessage {
  return createToolUseMessage('Grep', { pattern: searchPattern, path, glob });
}

// =============================================================================
// Scenario Builders
// =============================================================================

/**
 * Extracts the tool use ID from a tool use message.
 */
function getToolUseId(message: ChatMessage): string {
  const event = message.message?.event;
  if (event?.type === 'content_block_start') {
    const block = event.content_block as ToolUseContent;
    if (block.type === 'tool_use') {
      return block.id;
    }
  }
  return generateToolUseId();
}

/**
 * Creates a read file scenario with user request, tool use, and result.
 */
export function createReadFileScenario(): ChatMessage[] {
  const userMsg = createUserMessage('Can you read the Button component file?');
  const assistantMsg = createAssistantMessage("I'll read the Button component file for you.");
  const toolUse = createReadToolUse(SAMPLE_FILE_PATHS.typescript);
  const toolResult = createToolResultMessage(
    getToolUseId(toolUse),
    SAMPLE_FILE_CONTENTS.typescript
  );
  const followUp = createAssistantMessage(
    'I\'ve read the Button component. It\'s a React functional component that accepts label, onClick, and an optional variant prop. The variant defaults to "primary" and is used to apply different CSS classes.'
  );

  return [userMsg, assistantMsg, toolUse, toolResult, followUp];
}

/**
 * Creates an edit file scenario with user request, read, edit, and verification.
 */
export function createEditFileScenario(): ChatMessage[] {
  const userMsg = createUserMessage(
    'Change the default variant to "secondary" in the Button component.'
  );
  const assistantMsg = createAssistantMessage(
    "I'll first read the current Button component to understand its structure, then make the change."
  );
  const readToolUse = createReadToolUse(SAMPLE_FILE_PATHS.typescript);
  const readResult = createToolResultMessage(
    getToolUseId(readToolUse),
    SAMPLE_FILE_CONTENTS.typescript
  );
  const editToolUse = createEditToolUse(
    SAMPLE_FILE_PATHS.typescript,
    "variant = 'primary'",
    "variant = 'secondary'"
  );
  const editResult = createToolResultMessage(getToolUseId(editToolUse), 'Successfully edited file');
  const followUp = createAssistantMessage(
    "I've updated the Button component's default variant from 'primary' to 'secondary'. The change has been applied successfully."
  );

  return [userMsg, assistantMsg, readToolUse, readResult, editToolUse, editResult, followUp];
}

/**
 * Creates a bash command scenario with user request and command execution.
 */
export function createBashCommandScenario(): ChatMessage[] {
  const userMsg = createUserMessage('Run the tests for this project.');
  const assistantMsg = createAssistantMessage("I'll run the test suite for you.");
  const toolUse = createBashToolUse('npm test', 'Run the project test suite');
  const toolResult = createToolResultMessage(getToolUseId(toolUse), SAMPLE_BASH_OUTPUTS.npmTest);
  const followUp = createAssistantMessage(
    'All tests passed successfully! The Button component has 3 passing tests covering rendering, click handling, and variant class application.'
  );

  return [userMsg, assistantMsg, toolUse, toolResult, followUp];
}

/**
 * Creates a conversation with errors to test error handling UI.
 */
export function createConversationWithErrors(): ChatMessage[] {
  const userMsg = createUserMessage('Read the file at /nonexistent/path.ts');
  const assistantMsg = createAssistantMessage("I'll try to read that file.");
  const toolUse = createToolUseMessage('Read', { file_path: '/nonexistent/path.ts' });
  const toolResult = createToolResultMessage(
    getToolUseId(toolUse),
    "Error: ENOENT: no such file or directory, open '/nonexistent/path.ts'",
    true
  );
  const errorFollowUp = createAssistantMessage(
    "I apologize, but that file doesn't exist. Could you please check the file path and try again?"
  );
  const systemError = createErrorMessage(
    'Connection to Claude CLI was interrupted. Please try again.'
  );

  return [userMsg, assistantMsg, toolUse, toolResult, errorFollowUp, systemError];
}

/**
 * Creates a streaming conversation with incremental updates.
 */
export function createStreamingConversation(): ChatMessage[] {
  const userMsg = createUserMessage('Explain how React hooks work.');

  // Message start
  const messageStart = createStreamEventMessage({
    type: 'message_start',
    message: {
      role: 'assistant',
      content: [],
    },
  });

  // Content block start with initial text
  const contentStart = createStreamEventMessage({
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'text',
      text: 'React hooks are ',
    },
  });

  // Text delta updates
  const delta1 = createStreamEventMessage({
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'text_delta',
      text: 'functions that let you use ',
    },
  });

  const delta2 = createStreamEventMessage({
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'text_delta',
      text: 'state and other React features ',
    },
  });

  const delta3 = createStreamEventMessage({
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'text_delta',
      text: 'in functional components.',
    },
  });

  // Content block stop
  const contentStop = createStreamEventMessage({
    type: 'content_block_stop',
    index: 0,
  });

  // Message stop
  const messageStop = createStreamEventMessage({
    type: 'message_stop',
  });

  return [userMsg, messageStart, contentStart, delta1, delta2, delta3, contentStop, messageStop];
}

/**
 * Creates a multi-tool scenario with multiple tools used in sequence.
 */
export function createMultiToolScenario(): ChatMessage[] {
  const userMsg = createUserMessage(
    'Find all TypeScript files with "Button" in the name and show me their contents.'
  );
  const assistantMsg = createAssistantMessage(
    "I'll search for TypeScript files with 'Button' in the name and then read their contents."
  );

  // Glob to find files
  const globToolUse = createGlobToolUse('**/*Button*.ts*');
  const globResult = createToolResultMessage(
    getToolUseId(globToolUse),
    JSON.stringify(
      [
        '/Users/developer/project/src/components/Button.tsx',
        '/Users/developer/project/src/components/IconButton.tsx',
        '/Users/developer/project/src/components/Button.test.tsx',
      ],
      null,
      2
    )
  );

  // Read first file
  const read1 = createReadToolUse('/Users/developer/project/src/components/Button.tsx');
  const read1Result = createToolResultMessage(getToolUseId(read1), SAMPLE_FILE_CONTENTS.typescript);

  // Read second file
  const read2 = createReadToolUse('/Users/developer/project/src/components/IconButton.tsx');
  const read2Result = createToolResultMessage(
    getToolUseId(read2),
    `import React from 'react';
import { Button } from './Button';
import type { IconType } from '../icons';

interface IconButtonProps {
  icon: IconType;
  label: string;
  onClick: () => void;
}

export function IconButton({ icon, label, onClick }: IconButtonProps) {
  return (
    <Button onClick={onClick} label={label}>
      <span className="icon">{icon}</span>
    </Button>
  );
}`
  );

  const summary = createAssistantMessage(
    'I found 3 TypeScript files with "Button" in the name:\n\n1. **Button.tsx** - The main Button component with label, onClick, and variant props\n2. **IconButton.tsx** - A wrapper component that adds an icon to the Button\n3. **Button.test.tsx** - Test file for the Button component\n\nThe IconButton extends the base Button by adding an icon prop.'
  );

  return [
    userMsg,
    assistantMsg,
    globToolUse,
    globResult,
    read1,
    read1Result,
    read2,
    read2Result,
    summary,
  ];
}

/**
 * Creates a conversation with thinking/reasoning content.
 */
export function createThinkingScenario(): ChatMessage[] {
  const userMsg = createUserMessage(
    'What is the best way to refactor this component for better performance?'
  );

  const thinkingMsg = createThinkingMessage(
    'Let me analyze this component for performance issues. I should look for:\n' +
      '1. Unnecessary re-renders\n' +
      '2. Missing memoization\n' +
      '3. Expensive computations that could be cached\n' +
      '4. State that could be lifted or colocated\n\n' +
      'The Button component is simple, but I should check if the onClick handler is stable...'
  );

  const assistantMsg = createAssistantMessage(
    'Based on my analysis, here are the recommended optimizations:\n\n' +
      '1. **Memoize the component** using `React.memo()` to prevent unnecessary re-renders\n' +
      "2. **Use `useCallback`** for the onClick handler if it's passed from a parent\n" +
      '3. **Consider CSS modules** instead of template literals for class names\n\n' +
      'Would you like me to implement these changes?'
  );

  return [userMsg, thinkingMsg, assistantMsg];
}

/**
 * Creates a permission request scenario.
 */
export function createPermissionScenario(): {
  messages: ChatMessage[];
  permissionRequest: PermissionRequest;
} {
  const userMsg = createUserMessage('Delete all temporary files in the project.');
  const assistantMsg = createAssistantMessage(
    "I'll help you delete temporary files. This will require executing a command that modifies files."
  );

  const permissionRequest = createPermissionRequest('Bash', {
    command: 'find . -name "*.tmp" -type f -delete',
    description: 'Delete all .tmp files recursively',
  });

  return {
    messages: [userMsg, assistantMsg],
    permissionRequest,
  };
}

/**
 * Creates a user question scenario.
 */
export function createUserQuestionScenario(): {
  messages: ChatMessage[];
  questionRequest: UserQuestionRequest;
} {
  const userMsg = createUserMessage('Set up a new React component.');
  const assistantMsg = createAssistantMessage(
    "I'd like to understand your preferences before creating the component."
  );

  const questionRequest = createUserQuestion([
    {
      question: 'What type of component would you like to create?',
      options: [
        {
          label: 'Functional Component',
          description: 'Modern React function component with hooks',
        },
        { label: 'Class Component', description: 'Traditional React class-based component' },
      ],
    },
    {
      question: 'Would you like to include TypeScript types?',
      options: [
        { label: 'Yes', description: 'Include full TypeScript interface definitions' },
        { label: 'No', description: 'Plain JavaScript without type annotations' },
      ],
    },
  ]);

  return {
    messages: [userMsg, assistantMsg],
    questionRequest,
  };
}

/**
 * Creates a scenario with many adjacent tool calls for testing tool grouping.
 */
export function createManyToolsScenario(): ChatMessage[] {
  const userMsg = createUserMessage('Read all the component files and check the tests.');
  const assistantMsg = createAssistantMessage(
    "I'll read the component files and check the test suite."
  );

  // Multiple adjacent tool uses with their results
  const read1 = createReadToolUse('/Users/developer/project/src/components/Button.tsx');
  const read1Result = createToolResultMessage(getToolUseId(read1), SAMPLE_FILE_CONTENTS.typescript);

  const read2 = createReadToolUse('/Users/developer/project/src/components/Input.tsx');
  const read2Result = createToolResultMessage(
    getToolUseId(read2),
    'export function Input({ value, onChange }) { return <input value={value} onChange={onChange} />; }'
  );

  const read3 = createReadToolUse('/Users/developer/project/src/components/Card.tsx');
  const read3Result = createToolResultMessage(
    getToolUseId(read3),
    'export function Card({ children }) { return <div className="card">{children}</div>; }'
  );

  const bashTest = createBashToolUse('npm test', 'Run the test suite');
  const bashTestResult = createToolResultMessage(
    getToolUseId(bashTest),
    SAMPLE_BASH_OUTPUTS.npmTest
  );

  const summary = createAssistantMessage(
    "I've read 3 component files (Button, Input, Card) and verified that all tests pass. The components are well-structured functional React components."
  );

  return [
    userMsg,
    assistantMsg,
    read1,
    read1Result,
    read2,
    read2Result,
    read3,
    read3Result,
    bashTest,
    bashTestResult,
    summary,
  ];
}

/**
 * Creates a scenario with adjacent tool calls where some fail.
 */
export function createManyToolsWithErrorsScenario(): ChatMessage[] {
  const userMsg = createUserMessage('Read these three files.');
  const assistantMsg = createAssistantMessage("I'll read the three files.");

  const read1 = createReadToolUse('/Users/developer/project/src/valid.ts');
  const read1Result = createToolResultMessage(getToolUseId(read1), 'export const valid = true;');

  const read2 = createToolUseMessage('Read', {
    file_path: '/Users/developer/project/src/missing.ts',
  });
  const read2Result = createToolResultMessage(
    getToolUseId(read2),
    'Error: ENOENT: no such file or directory',
    true
  );

  const read3 = createReadToolUse('/Users/developer/project/src/another.ts');
  const read3Result = createToolResultMessage(getToolUseId(read3), 'export const another = 42;');

  const followUp = createAssistantMessage(
    'I was able to read 2 of the 3 files. The file missing.ts does not exist.'
  );

  return [
    userMsg,
    assistantMsg,
    read1,
    read1Result,
    read2,
    read2Result,
    read3,
    read3Result,
    followUp,
  ];
}

/**
 * Creates a complete conversation with system init, multiple exchanges, and result.
 */
export function createCompleteConversation(): ChatMessage[] {
  const systemMsg = createSystemMessage('claude-sonnet-4-20250514');

  const exchange1 = [
    createUserMessage('What files are in the src directory?'),
    createAssistantMessage("I'll list the files in the src directory."),
    createBashToolUse('ls -la src/', 'List files in src directory'),
  ];
  const exchange1ToolUse = exchange1[2];
  if (!exchange1ToolUse) {
    throw new Error('Expected exchange1 tool use message');
  }
  const toolResult1 = createToolResultMessage(
    getToolUseId(exchange1ToolUse),
    `total 24
drwxr-xr-x   5 developer  staff   160 Jan 15 10:30 .
drwxr-xr-x  12 developer  staff   384 Jan 15 10:30 ..
drwxr-xr-x   4 developer  staff   128 Jan 15 10:30 components
drwxr-xr-x   3 developer  staff    96 Jan 15 10:30 utils
-rw-r--r--   1 developer  staff  1234 Jan 15 10:30 index.ts`
  );

  const exchange2 = [
    createAssistantMessage(
      'The src directory contains:\n- **components/** - Component files\n- **utils/** - Utility functions\n- **index.ts** - Main entry point'
    ),
    createUserMessage('Read the index.ts file'),
    createAssistantMessage("I'll read the index.ts file."),
    createReadToolUse('/Users/developer/project/src/index.ts'),
  ];
  const exchange2ToolUse = exchange2[3];
  if (!exchange2ToolUse) {
    throw new Error('Expected exchange2 tool use message');
  }
  const toolResult2 = createToolResultMessage(
    getToolUseId(exchange2ToolUse),
    `export { Button } from './components/Button';
export { IconButton } from './components/IconButton';
export * from './utils/helpers';`
  );

  const finalResponse = createAssistantMessage(
    'The index.ts file is the main entry point that exports the Button and IconButton components, along with all utility helpers.'
  );

  const result = createResultMessage({
    inputTokens: 2500,
    outputTokens: 1200,
    totalCostUsd: 0.0185,
    totalDurationMs: 8500,
    turnCount: 4,
  });

  return [systemMsg, ...exchange1, toolResult1, ...exchange2, toolResult2, finalResponse, result];
}

// =============================================================================
// Reset Functions (useful for tests)
// =============================================================================

/**
 * Resets all ID counters. Useful for deterministic test output.
 */
export function resetIdCounters(): void {
  messageIdCounter = 0;
  toolUseIdCounter = 0;
}
