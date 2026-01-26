import type { Meta, StoryObj } from '@storybook/react';
import {
  createAgentMetadata,
  createBashCommandScenario,
  createCompleteConversation,
  createConversationWithErrors,
  createEditFileScenario,
  createManyToolsScenario,
  createManyToolsWithErrorsScenario,
  createMultiToolScenario,
  createPermissionScenario,
  createReadFileScenario,
  createStreamingConversation,
  createThinkingScenario,
  createTokenStats,
  createUserQuestionScenario,
  resetIdCounters,
} from '@/lib/claude-fixtures';
import { MockAgentActivity, MockCompactAgentActivity } from './agent-activity';

// Reset ID counters for consistent IDs across story renders
resetIdCounters();

const meta = {
  title: 'AgentActivity/AgentActivity',
  component: MockAgentActivity,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: `
The AgentActivity component provides a real-time view of agent Claude sessions.
It connects via WebSocket to stream messages and displays them with token statistics.

These stories use MockAgentActivity, which accepts pre-loaded messages as props
for testing without requiring a WebSocket connection.

### Related Stories
- \`AgentActivity/StatusBar\` - Connection and agent status indicators
- \`AgentActivity/StatsPanel\` - Token usage and cost statistics
- \`AgentActivity/ToolRenderers\` - Tool call and result rendering
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
  argTypes: {
    messages: {
      control: false,
      description: 'Array of ChatMessage objects to display',
    },
    connectionState: {
      control: 'select',
      options: ['connected', 'connecting', 'disconnected', 'error'],
      description: 'Simulated connection state',
    },
    running: {
      control: 'boolean',
      description: 'Whether the agent appears to be running',
    },
    showStats: {
      control: 'boolean',
      description: 'Whether to show the stats panel',
    },
    showStatusBar: {
      control: 'boolean',
      description: 'Whether to show the status bar',
    },
    height: {
      control: 'text',
      description: 'Height of the scroll area (Tailwind class)',
    },
  },
} satisfies Meta<typeof MockAgentActivity>;

export default meta;
type Story = StoryObj<typeof meta>;

// =============================================================================
// Main Component Stories
// =============================================================================

/**
 * Default view showing a complete conversation with multiple tool calls,
 * messages, and results.
 */
export const Default: Story = {
  args: {
    messages: createCompleteConversation(),
    connectionState: 'connected',
    running: false,
    showStats: true,
    showStatusBar: true,
    tokenStats: createTokenStats({
      inputTokens: 2500,
      outputTokens: 1200,
      totalCostUsd: 0.0185,
      totalDurationMs: 8500,
      turnCount: 4,
    }),
    agentMetadata: createAgentMetadata({
      type: 'WORKER',
      executionState: 'RUNNING',
    }),
    height: 'h-[500px]',
  },
};

/**
 * Shows a read file operation scenario with user request, tool use, and result.
 */
export const ReadFileScenario: Story = {
  args: {
    messages: createReadFileScenario(),
    connectionState: 'connected',
    running: false,
    showStats: true,
    showStatusBar: true,
    tokenStats: createTokenStats({
      inputTokens: 800,
      outputTokens: 450,
      totalCostUsd: 0.0065,
      turnCount: 2,
    }),
    agentMetadata: createAgentMetadata(),
    height: 'h-[500px]',
  },
};

/**
 * Shows an edit file operation with read, edit, and verification steps.
 */
export const EditFileScenario: Story = {
  args: {
    messages: createEditFileScenario(),
    connectionState: 'connected',
    running: false,
    showStats: true,
    showStatusBar: true,
    tokenStats: createTokenStats({
      inputTokens: 1200,
      outputTokens: 600,
      totalCostUsd: 0.009,
      turnCount: 3,
    }),
    agentMetadata: createAgentMetadata(),
    height: 'h-[500px]',
  },
};

/**
 * Shows bash command execution with output.
 */
export const BashCommandScenario: Story = {
  args: {
    messages: createBashCommandScenario(),
    connectionState: 'connected',
    running: false,
    showStats: true,
    showStatusBar: true,
    tokenStats: createTokenStats({
      inputTokens: 500,
      outputTokens: 300,
      totalCostUsd: 0.004,
      turnCount: 2,
    }),
    agentMetadata: createAgentMetadata(),
    height: 'h-[500px]',
  },
};

/**
 * Shows multiple tools being used in sequence (glob + read).
 */
export const MultiToolScenario: Story = {
  args: {
    messages: createMultiToolScenario(),
    connectionState: 'connected',
    running: false,
    showStats: true,
    showStatusBar: true,
    tokenStats: createTokenStats({
      inputTokens: 1800,
      outputTokens: 950,
      totalCostUsd: 0.014,
      turnCount: 4,
    }),
    agentMetadata: createAgentMetadata(),
    height: 'h-[500px]',
  },
};

/**
 * Shows many adjacent tool calls grouped together in a collapsible container.
 * The group shows a summary like "4 tools: Read, Read, Read, Bash [checkmark][checkmark][checkmark][checkmark]"
 */
export const GroupedToolCalls: Story = {
  args: {
    messages: createManyToolsScenario(),
    connectionState: 'connected',
    running: false,
    showStats: true,
    showStatusBar: true,
    tokenStats: createTokenStats({
      inputTokens: 2200,
      outputTokens: 1100,
      totalCostUsd: 0.016,
      turnCount: 5,
    }),
    agentMetadata: createAgentMetadata(),
    height: 'h-[500px]',
  },
};

/**
 * Shows grouped tool calls where some have errors.
 * Demonstrates error status indicators in the group summary.
 */
export const GroupedToolCallsWithErrors: Story = {
  args: {
    messages: createManyToolsWithErrorsScenario(),
    connectionState: 'connected',
    running: false,
    showStats: true,
    showStatusBar: true,
    tokenStats: createTokenStats({
      inputTokens: 1500,
      outputTokens: 800,
      totalCostUsd: 0.012,
      turnCount: 4,
    }),
    agentMetadata: createAgentMetadata(),
    height: 'h-[500px]',
  },
};

/**
 * Shows thinking/reasoning content before the response.
 */
export const WithThinking: Story = {
  args: {
    messages: createThinkingScenario(),
    connectionState: 'connected',
    running: false,
    showStats: true,
    showStatusBar: true,
    tokenStats: createTokenStats(),
    agentMetadata: createAgentMetadata(),
    height: 'h-[500px]',
  },
};

/**
 * Shows the agent in an active running state with loading indicator.
 */
export const Running: Story = {
  args: {
    messages: createReadFileScenario().slice(0, 3), // Partial conversation
    connectionState: 'connected',
    running: true,
    showStats: true,
    showStatusBar: true,
    tokenStats: createTokenStats({
      inputTokens: 400,
      outputTokens: 150,
      totalCostUsd: 0.003,
      turnCount: 1,
    }),
    agentMetadata: createAgentMetadata({
      executionState: 'RUNNING',
      cliProcessStatus: 'RUNNING',
    }),
    height: 'h-[500px]',
  },
};

/**
 * Shows error handling with tool errors and system errors.
 */
export const WithErrors: Story = {
  args: {
    messages: createConversationWithErrors(),
    connectionState: 'connected',
    running: false,
    showStats: true,
    showStatusBar: true,
    error: 'Connection to Claude CLI was interrupted',
    tokenStats: createTokenStats({
      inputTokens: 300,
      outputTokens: 100,
      totalCostUsd: 0.002,
      turnCount: 2,
    }),
    agentMetadata: createAgentMetadata({
      isHealthy: false,
    }),
    height: 'h-[500px]',
  },
};

/**
 * Shows the disconnected state.
 */
export const Disconnected: Story = {
  args: {
    messages: [],
    connectionState: 'disconnected',
    running: false,
    showStats: true,
    showStatusBar: true,
    tokenStats: null,
    agentMetadata: null,
    height: 'h-[500px]',
  },
};

/**
 * Shows the connecting state with skeleton loading.
 */
export const Connecting: Story = {
  args: {
    messages: [],
    connectionState: 'connecting',
    running: false,
    showStats: true,
    showStatusBar: true,
    tokenStats: null,
    agentMetadata: null,
    height: 'h-[500px]',
  },
};

/**
 * Shows the error connection state.
 */
export const ConnectionError: Story = {
  args: {
    messages: [],
    connectionState: 'error',
    running: false,
    showStats: true,
    showStatusBar: true,
    error: 'Failed to connect to agent WebSocket',
    tokenStats: null,
    agentMetadata: null,
    height: 'h-[500px]',
  },
};

/**
 * Configuration without the stats panel for a more focused message view.
 */
export const WithoutStats: Story = {
  args: {
    messages: createCompleteConversation(),
    connectionState: 'connected',
    running: false,
    showStats: false,
    showStatusBar: true,
    tokenStats: createTokenStats(),
    agentMetadata: createAgentMetadata(),
    height: 'h-[500px]',
  },
};

/**
 * Configuration without the status bar for embedding in other UI.
 */
export const WithoutStatusBar: Story = {
  args: {
    messages: createCompleteConversation(),
    connectionState: 'connected',
    running: false,
    showStats: true,
    showStatusBar: false,
    tokenStats: createTokenStats(),
    agentMetadata: createAgentMetadata(),
    height: 'h-[500px]',
  },
};

/**
 * Minimal configuration showing only messages.
 */
export const MessagesOnly: Story = {
  args: {
    messages: createReadFileScenario(),
    connectionState: 'connected',
    running: false,
    showStats: false,
    showStatusBar: false,
    tokenStats: null,
    agentMetadata: null,
    height: 'h-[400px]',
  },
};

// =============================================================================
// CompactAgentActivity Stories
// =============================================================================

/**
 * Compact version of AgentActivity for space-constrained layouts.
 */
export const Compact: Story = {
  args: {
    messages: createCompleteConversation(),
  },
  render: (args) => (
    <MockCompactAgentActivity
      messages={args.messages}
      connectionState="connected"
      running={false}
      tokenStats={createTokenStats()}
      maxMessages={10}
    />
  ),
};

/**
 * Compact view with fewer messages displayed.
 */
export const CompactFewMessages: Story = {
  args: {
    messages: createCompleteConversation(),
  },
  render: (args) => (
    <MockCompactAgentActivity
      messages={args.messages}
      connectionState="connected"
      running={false}
      tokenStats={createTokenStats()}
      maxMessages={5}
    />
  ),
};

/**
 * Compact view in running state.
 */
export const CompactRunning: Story = {
  args: {
    messages: createReadFileScenario().slice(0, 3),
  },
  render: (args) => (
    <MockCompactAgentActivity
      messages={args.messages}
      connectionState="connected"
      running={true}
      tokenStats={createTokenStats({
        inputTokens: 200,
        outputTokens: 50,
      })}
      maxMessages={10}
    />
  ),
};

/**
 * Compact view in disconnected state.
 */
export const CompactDisconnected: Story = {
  args: {
    messages: [],
  },
  render: () => (
    <MockCompactAgentActivity
      messages={[]}
      connectionState="disconnected"
      running={false}
      tokenStats={null}
      maxMessages={10}
    />
  ),
};

// =============================================================================
// Layout Examples
// =============================================================================

/**
 * Dashboard layout with multiple compact agent views and a main supervisor view.
 */
export const DashboardLayout: Story = {
  args: {
    messages: createCompleteConversation(),
  },
  decorators: [
    (Story) => (
      <div style={{ height: '800px' }}>
        <Story />
      </div>
    ),
  ],
  render: () => (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <h3 className="text-sm font-medium mb-2">Worker Agent 1</h3>
        <MockCompactAgentActivity
          messages={createReadFileScenario()}
          connectionState="connected"
          running={false}
          tokenStats={createTokenStats({ inputTokens: 500, outputTokens: 200 })}
          maxMessages={5}
        />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Worker Agent 2</h3>
        <MockCompactAgentActivity
          messages={createBashCommandScenario()}
          connectionState="connected"
          running={true}
          tokenStats={createTokenStats({ inputTokens: 300, outputTokens: 100 })}
          maxMessages={5}
        />
      </div>
      <div className="col-span-2">
        <h3 className="text-sm font-medium mb-2">Supervisor Agent</h3>
        <MockAgentActivity
          messages={createCompleteConversation()}
          connectionState="connected"
          running={false}
          showStats={true}
          showStatusBar={true}
          tokenStats={createTokenStats({
            inputTokens: 2500,
            outputTokens: 1200,
            totalCostUsd: 0.0185,
          })}
          agentMetadata={createAgentMetadata({ type: 'SUPERVISOR' })}
          height="h-[300px]"
        />
      </div>
    </div>
  ),
};

/**
 * Side panel layout with main content area and agent activity sidebar.
 */
export const SidePanelLayout: Story = {
  args: {
    messages: createMultiToolScenario(),
  },
  render: () => (
    <div className="flex gap-4">
      <div className="flex-1 rounded-md border p-4">
        <h3 className="text-sm font-medium mb-2">Main Content Area</h3>
        <div className="h-[400px] bg-muted/30 rounded-md flex items-center justify-center text-muted-foreground">
          Application Content
        </div>
      </div>
      <div className="w-80">
        <h3 className="text-sm font-medium mb-2">Agent Activity</h3>
        <MockAgentActivity
          messages={createMultiToolScenario()}
          connectionState="connected"
          running={false}
          showStats={false}
          showStatusBar={true}
          tokenStats={createTokenStats()}
          agentMetadata={createAgentMetadata()}
          height="h-[400px]"
        />
      </div>
    </div>
  ),
};

/**
 * Multiple agent states shown side by side for comparison.
 */
export const StateComparison: Story = {
  args: {
    messages: [],
  },
  decorators: [
    (Story) => (
      <div style={{ height: '300px' }}>
        <Story />
      </div>
    ),
  ],
  render: () => (
    <div className="grid grid-cols-4 gap-4">
      <div>
        <h4 className="text-xs font-medium mb-2 text-muted-foreground">Connected</h4>
        <MockCompactAgentActivity
          messages={createReadFileScenario()}
          connectionState="connected"
          running={false}
          tokenStats={createTokenStats()}
        />
      </div>
      <div>
        <h4 className="text-xs font-medium mb-2 text-muted-foreground">Running</h4>
        <MockCompactAgentActivity
          messages={createReadFileScenario().slice(0, 2)}
          connectionState="connected"
          running={true}
          tokenStats={createTokenStats()}
        />
      </div>
      <div>
        <h4 className="text-xs font-medium mb-2 text-muted-foreground">Connecting</h4>
        <MockCompactAgentActivity
          messages={[]}
          connectionState="connecting"
          running={false}
          tokenStats={null}
        />
      </div>
      <div>
        <h4 className="text-xs font-medium mb-2 text-muted-foreground">Disconnected</h4>
        <MockCompactAgentActivity
          messages={[]}
          connectionState="disconnected"
          running={false}
          tokenStats={null}
        />
      </div>
    </div>
  ),
};

// =============================================================================
// Additional Scenario Stories
// =============================================================================

/**
 * Demonstrates streaming message updates:
 * Shows the sequence of stream events as content is progressively built up.
 *
 * Includes: message_start, content_block_start, multiple text_deltas,
 * content_block_stop, and message_stop events.
 */
export const StreamingConversation: Story = {
  args: {
    messages: createStreamingConversation(),
    connectionState: 'connected',
    running: true,
    showStats: false,
    showStatusBar: true,
    tokenStats: createTokenStats({ inputTokens: 100, outputTokens: 50 }),
    agentMetadata: createAgentMetadata({ executionState: 'RUNNING' }),
    height: 'h-[500px]',
  },
};

/**
 * Demonstrates the permission request flow:
 * User asks to delete files -> Assistant prepares to run a command.
 *
 * Shows the messages leading up to a permission request.
 */
export const PermissionRequestFlow: Story = {
  args: {
    messages: createPermissionScenario().messages,
    connectionState: 'connected',
    running: false,
    showStats: false,
    showStatusBar: false,
    tokenStats: null,
    agentMetadata: null,
    height: 'h-[500px]',
  },
};

/**
 * Demonstrates the AskUserQuestion flow:
 * User asks to create a component -> Assistant needs more info.
 *
 * Shows the messages leading up to asking the user questions.
 */
export const UserQuestionFlow: Story = {
  args: {
    messages: createUserQuestionScenario().messages,
    connectionState: 'connected',
    running: false,
    showStats: false,
    showStatusBar: false,
    tokenStats: null,
    agentMetadata: null,
    height: 'h-[500px]',
  },
};

/**
 * Demonstrates a realistic development workflow combining multiple operations:
 * Reading files, editing, running tests, and handling results.
 */
export const FullDevelopmentWorkflow: Story = {
  args: {
    messages: [
      ...createReadFileScenario(),
      ...createEditFileScenario().slice(2), // Skip duplicate read, start from edit
      ...createBashCommandScenario().slice(2), // Skip setup, just show test run
    ],
    connectionState: 'connected',
    running: false,
    showStats: true,
    showStatusBar: true,
    tokenStats: createTokenStats({
      inputTokens: 3500,
      outputTokens: 1800,
      totalCostUsd: 0.027,
      turnCount: 6,
    }),
    agentMetadata: createAgentMetadata(),
    height: 'h-[500px]',
  },
};

/**
 * A long conversation demonstrating scroll behavior and message grouping.
 * Contains multiple exchanges to test the message list's handling of extended conversations.
 */
export const LongConversation: Story = {
  args: {
    messages: [
      ...createCompleteConversation(),
      ...createMultiToolScenario().slice(1), // Add more content
      ...createThinkingScenario(),
      ...createBashCommandScenario(),
    ],
    connectionState: 'connected',
    running: false,
    showStats: true,
    showStatusBar: true,
    tokenStats: createTokenStats({
      inputTokens: 8000,
      outputTokens: 4500,
      totalCostUsd: 0.065,
      turnCount: 12,
    }),
    agentMetadata: createAgentMetadata(),
    height: 'h-[500px]',
  },
};
