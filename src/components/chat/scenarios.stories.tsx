import type { Meta, StoryObj } from '@storybook/react';

import {
  createBashCommandScenario,
  createCompleteConversation,
  createConversationWithErrors,
  createEditFileScenario,
  createMultiToolScenario,
  createPermissionScenario,
  createReadFileScenario,
  createStreamingConversation,
  createThinkingScenario,
  createUserQuestionScenario,
  resetIdCounters,
} from '@/lib/claude-fixtures';

import { MessageList } from './message-list';

// =============================================================================
// Story Setup
// =============================================================================

const meta = {
  title: 'Chat/Scenarios',
  component: MessageList,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => {
      // Reset counters for consistent IDs across stories
      resetIdCounters();
      return (
        <div className="h-[600px] w-full max-w-4xl mx-auto border rounded-lg overflow-hidden bg-background">
          <Story />
        </div>
      );
    },
  ],
} satisfies Meta<typeof MessageList>;

export default meta;
type Story = StoryObj<typeof meta>;

// =============================================================================
// File Operation Scenarios
// =============================================================================

/**
 * Demonstrates a complete file reading workflow:
 * User requests to read a file -> Assistant acknowledges -> Read tool is used ->
 * Result is returned -> Assistant summarizes the content.
 */
export const FileReadingWorkflow: Story = {
  name: 'File Reading Workflow',
  args: {
    messages: createReadFileScenario(),
  },
};

/**
 * Demonstrates a file editing workflow:
 * User requests a change -> Assistant reads the file first -> Makes the edit ->
 * Returns success result -> Assistant confirms the change.
 */
export const FileEditingWorkflow: Story = {
  name: 'File Editing Workflow',
  args: {
    messages: createEditFileScenario(),
  },
};

// =============================================================================
// Command Execution Scenarios
// =============================================================================

/**
 * Demonstrates bash command execution:
 * User requests to run tests -> Assistant runs npm test ->
 * Command output is shown -> Assistant summarizes results.
 */
export const BashCommandWorkflow: Story = {
  name: 'Bash Command Workflow',
  args: {
    messages: createBashCommandScenario(),
  },
};

// =============================================================================
// Error Handling Scenarios
// =============================================================================

/**
 * Demonstrates error handling in the UI:
 * User requests a file that doesn't exist -> Tool returns an error ->
 * Assistant apologizes and asks for correction -> System error is shown.
 *
 * This shows both tool-level errors (file not found) and system-level errors
 * (connection interrupted).
 */
export const ErrorHandling: Story = {
  name: 'Error Handling',
  args: {
    messages: createConversationWithErrors(),
  },
};

// =============================================================================
// Streaming Scenarios
// =============================================================================

/**
 * Demonstrates streaming message updates:
 * Shows the sequence of stream events as content is progressively built up.
 *
 * Includes: message_start, content_block_start, multiple text_deltas,
 * content_block_stop, and message_stop events.
 */
export const StreamingConversation: Story = {
  name: 'Streaming Conversation',
  args: {
    messages: createStreamingConversation(),
    running: true,
  },
};

// =============================================================================
// Multi-Tool Scenarios
// =============================================================================

/**
 * Demonstrates multiple tools used in sequence:
 * User asks to find files and read them -> Glob finds matching files ->
 * Multiple Read operations fetch file contents -> Assistant summarizes.
 *
 * Shows how complex operations chain together.
 */
export const MultiToolOperation: Story = {
  name: 'Multi-Tool Operation',
  args: {
    messages: createMultiToolScenario(),
  },
};

// =============================================================================
// Thinking/Reasoning Scenarios
// =============================================================================

/**
 * Demonstrates extended thinking blocks:
 * User asks about refactoring -> Claude's internal reasoning is shown ->
 * Final recommendations are provided.
 *
 * Thinking blocks show Claude's analysis process before responding.
 */
export const ThinkingProcess: Story = {
  name: 'Thinking Process',
  args: {
    messages: createThinkingScenario(),
  },
};

// =============================================================================
// Complete Conversation Scenarios
// =============================================================================

/**
 * A complete conversation showing the full lifecycle:
 * - System initialization with model and tools
 * - Multiple user/assistant exchanges
 * - Various tool uses (bash, read)
 * - Final result with token usage stats
 *
 * This represents what a typical coding session looks like.
 */
export const CompleteConversation: Story = {
  name: 'Complete Conversation',
  args: {
    messages: createCompleteConversation(),
  },
};

// =============================================================================
// Permission Request Scenarios
// =============================================================================

/**
 * Demonstrates the permission request flow:
 * User asks to delete files -> Assistant prepares to run a command ->
 * (In practice, this would trigger a permission modal)
 *
 * Shows the messages leading up to a permission request.
 */
export const PermissionRequestFlow: Story = {
  name: 'Permission Request Flow',
  args: {
    messages: createPermissionScenario().messages,
  },
};

// =============================================================================
// User Question Scenarios
// =============================================================================

/**
 * Demonstrates the AskUserQuestion flow:
 * User asks to create a component -> Assistant needs more info ->
 * (In practice, this would trigger a question modal)
 *
 * Shows the messages leading up to asking the user questions.
 */
export const UserQuestionFlow: Story = {
  name: 'User Question Flow',
  args: {
    messages: createUserQuestionScenario().messages,
  },
};

// =============================================================================
// Running State Scenarios
// =============================================================================

/**
 * Shows the UI when Claude is actively processing.
 * The running prop enables the streaming indicator on the last message.
 */
export const ActivelyProcessing: Story = {
  name: 'Actively Processing',
  args: {
    messages: createReadFileScenario().slice(0, 3), // Stop mid-flow
    running: true,
  },
};

/**
 * Shows the UI after Claude has completed processing.
 * No streaming indicator is shown.
 */
export const CompletedProcessing: Story = {
  name: 'Completed Processing',
  args: {
    messages: createReadFileScenario(),
    running: false,
  },
};

// =============================================================================
// Combined Workflow Scenarios
// =============================================================================

/**
 * Demonstrates a realistic development workflow combining multiple operations:
 * Reading files, editing, running tests, and handling results.
 */
export const FullDevelopmentWorkflow: Story = {
  name: 'Full Development Workflow',
  args: {
    messages: [
      ...createReadFileScenario(),
      ...createEditFileScenario().slice(2), // Skip duplicate read, start from edit
      ...createBashCommandScenario().slice(2), // Skip setup, just show test run
    ],
  },
};

/**
 * A long conversation demonstrating scroll behavior and message grouping.
 * Contains multiple exchanges to test the message list's handling of extended conversations.
 */
export const LongConversation: Story = {
  name: 'Long Conversation',
  args: {
    messages: [
      ...createCompleteConversation(),
      ...createMultiToolScenario().slice(1), // Add more content
      ...createThinkingScenario(),
      ...createBashCommandScenario(),
    ],
  },
};
