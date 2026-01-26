import type { Meta, StoryObj } from '@storybook/react';

import {
  convertAllSessionMessages,
  getErrorResultMessages,
  getThinkingMessages,
  getToolUseMessagesConverted,
} from '@/lib/fixtures';

import { MockAgentActivity } from './agent-activity';

// =============================================================================
// Story Setup
// =============================================================================

const meta = {
  title: 'AgentActivity/RealSession',
  component: MockAgentActivity,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: `
Stories using real session data extracted from an actual Claude CLI session.
These provide realistic test cases showing actual message patterns, tool usage,
and conversation flows from real development sessions.
        `,
      },
    },
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div style={{ height: '600px' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MockAgentActivity>;

export default meta;
type Story = StoryObj<typeof meta>;

// =============================================================================
// Real Session Stories
// =============================================================================

/**
 * Full conversation flow using real messages from an actual Claude CLI session.
 * This demonstrates the natural flow of a coding session including user prompts,
 * assistant responses, tool usage, and results.
 */
export const RealSessionConversation: Story = {
  name: 'Real Session Conversation',
  args: {
    messages: convertAllSessionMessages().slice(0, 20),
    connectionState: 'connected',
    running: false,
    showStats: false,
    showStatusBar: false,
    height: 'h-[550px]',
  },
};

/**
 * Full session with all messages.
 * Shows the complete session data extracted from the fixture.
 */
export const FullSession: Story = {
  name: 'Full Session (All Messages)',
  args: {
    messages: convertAllSessionMessages(),
    connectionState: 'connected',
    running: false,
    showStats: false,
    showStatusBar: false,
    height: 'h-[550px]',
  },
};

// =============================================================================
// Filtered Tool Call Stories
// =============================================================================

/**
 * Filtered view showing only Read tool usage messages.
 * Demonstrates how the UI displays file reading operations.
 */
export const ReadToolCalls: Story = {
  name: 'Read Tool Calls',
  args: {
    messages: getToolUseMessagesConverted('Read'),
    connectionState: 'connected',
    running: false,
    showStats: false,
    showStatusBar: false,
    height: 'h-[550px]',
  },
};

/**
 * Filtered view showing only Bash command tool usage.
 * Demonstrates command execution tool rendering.
 */
export const BashToolCalls: Story = {
  name: 'Bash Tool Calls',
  args: {
    messages: getToolUseMessagesConverted('Bash'),
    connectionState: 'connected',
    running: false,
    showStats: false,
    showStatusBar: false,
    height: 'h-[550px]',
  },
};

/**
 * Filtered view showing only Edit tool usage.
 * Demonstrates file editing operations.
 */
export const EditToolCalls: Story = {
  name: 'Edit Tool Calls',
  args: {
    messages: getToolUseMessagesConverted('Edit'),
    connectionState: 'connected',
    running: false,
    showStats: false,
    showStatusBar: false,
    height: 'h-[550px]',
  },
};

/**
 * Filtered view showing only Glob and Grep search tool usage.
 * Demonstrates file search operations.
 */
export const SearchToolCalls: Story = {
  name: 'Search Tool Calls (Glob/Grep)',
  args: {
    messages: [...getToolUseMessagesConverted('Glob'), ...getToolUseMessagesConverted('Grep')],
    connectionState: 'connected',
    running: false,
    showStats: false,
    showStatusBar: false,
    height: 'h-[550px]',
  },
};

/**
 * Task tool calls showing sub-agent creation.
 * Demonstrates how the UI renders complex nested operations.
 */
export const TaskToolCalls: Story = {
  name: 'Task Tool Calls (Sub-agents)',
  args: {
    messages: getToolUseMessagesConverted('Task'),
    connectionState: 'connected',
    running: false,
    showStats: false,
    showStatusBar: false,
    height: 'h-[550px]',
  },
};

// =============================================================================
// Thinking and Error Stories
// =============================================================================

/**
 * Messages that include extended thinking/reasoning content.
 * Shows Claude's internal thought process before responding.
 */
export const RealThinkingBlocks: Story = {
  name: 'Real Thinking Blocks',
  args: {
    messages: getThinkingMessages(),
    connectionState: 'connected',
    running: false,
    showStats: false,
    showStatusBar: false,
    height: 'h-[550px]',
  },
};

/**
 * Messages showing error results from tool executions.
 * Demonstrates error handling and display in the UI.
 */
export const RealErrors: Story = {
  name: 'Real Errors',
  args: {
    messages: getErrorResultMessages(),
    connectionState: 'connected',
    running: false,
    showStats: false,
    showStatusBar: false,
    height: 'h-[550px]',
  },
};

// =============================================================================
// Combined Workflow Stories
// =============================================================================

/**
 * Mix of different tool types showing a typical development workflow.
 * Includes file reads, edits, and bash commands.
 */
export const MixedToolWorkflow: Story = {
  name: 'Mixed Tool Workflow',
  args: {
    messages: [
      ...getToolUseMessagesConverted('Read').slice(0, 2),
      ...getToolUseMessagesConverted('Edit').slice(0, 2),
      ...getToolUseMessagesConverted('Bash').slice(0, 2),
    ],
    connectionState: 'connected',
    running: false,
    showStats: false,
    showStatusBar: false,
    height: 'h-[550px]',
  },
};
