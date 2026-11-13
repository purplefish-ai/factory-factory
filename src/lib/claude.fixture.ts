/**
 * Test fixture factories for Claude CLI message types.
 *
 * This file provides factory functions for creating realistic test data
 * for Storybook stories and unit tests. All factories produce properly
 * typed messages that match the Claude CLI streaming protocol.
 */

import type {
  AgentMessage,
  AgentStreamEvent,
  AskUserQuestion,
  ChatMessage,
  PermissionRequest,
  TokenStats,
} from './chat-protocol';

// =============================================================================
// ID Generation
// =============================================================================

let messageIdCounter = 0;

/**
 * Generates a unique message ID.
 */
function generateMessageId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`;
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
  const claudeMessage: AgentMessage = {
    type: 'assistant',
    timestamp: generateTimestamp(),
    message: {
      role: 'assistant',
      content: text,
    },
  };

  return {
    id: generateMessageId(),
    source: 'agent',
    message: claudeMessage,
    timestamp: generateTimestamp(),
    order: order ?? fixtureOrderCounter++,
  };
}

/**
 * Creates a thinking content chat message.
 */
export function createThinkingMessage(thinking: string, order?: number): ChatMessage {
  const event: AgentStreamEvent = {
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'thinking',
      thinking,
    },
  };

  const claudeMessage: AgentMessage = {
    type: 'stream_event',
    timestamp: generateTimestamp(),
    event,
  };

  return {
    id: generateMessageId(),
    source: 'agent',
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
 * Creates token stats with optional overrides. */
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
    contextUsedTokens: overrides.contextUsedTokens ?? null,
    maxOutputTokens: overrides.maxOutputTokens ?? 16_384,
    serviceTier: overrides.serviceTier ?? null,
  };
}
