import type { Meta, StoryObj } from '@storybook/react';
import { AgentActivity, CompactAgentActivity } from './agent-activity';

/**
 * AgentActivity Component Stories
 *
 * NOTE: The AgentActivity and CompactAgentActivity components internally use
 * the useAgentWebSocket hook which requires an active WebSocket connection
 * to an agent. These stories demonstrate the component structure but will
 * show connection/loading states in Storybook since no real WebSocket
 * connection is available.
 *
 * For testing the full functionality, use the actual application with a
 * running agent, or see the individual component stories:
 * - AgentActivity/StatusBar - for connection and agent state display
 * - AgentActivity/StatsPanel - for token usage and cost statistics
 * - AgentActivity/ToolRenderers - for tool call visualization
 *
 * To properly test AgentActivity in isolation, you would need to:
 * 1. Create a mock WebSocket provider/context
 * 2. Mock the useAgentWebSocket hook using Storybook decorators
 * 3. Or refactor the component to accept messages as props (render props pattern)
 */

const meta = {
  title: 'AgentActivity/AgentActivity',
  component: AgentActivity,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: `
The AgentActivity component provides a real-time view of agent Claude sessions.
It connects via WebSocket to stream messages and displays them with token statistics.

**Note:** This component requires an active WebSocket connection to function properly.
In Storybook, it will show the connecting/empty state. See subcomponent stories for
detailed UI testing.

### Related Stories
- \`AgentActivity/StatusBar\` - Connection and agent status indicators
- \`AgentActivity/StatsPanel\` - Token usage and cost statistics
- \`AgentActivity/ToolRenderers\` - Tool call and result rendering
        `,
      },
    },
  },
  tags: ['autodocs'],
  argTypes: {
    agentId: {
      control: 'text',
      description: 'The agent ID to connect to',
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
    autoConnect: {
      control: 'boolean',
      description: 'Whether to auto-connect on mount',
    },
  },
} satisfies Meta<typeof AgentActivity>;

export default meta;
type Story = StoryObj<typeof meta>;

// =============================================================================
// Main Component Stories
// =============================================================================

/**
 * Default configuration showing the full AgentActivity component.
 * Will display connecting state in Storybook due to lack of WebSocket connection.
 */
export const Default: Story = {
  args: {
    agentId: 'agent-demo-123',
    showStats: true,
    showStatusBar: true,
    height: 'h-[500px]',
    autoConnect: true,
  },
};

/**
 * Configuration without the stats panel for a more focused message view.
 */
export const WithoutStats: Story = {
  args: {
    agentId: 'agent-demo-456',
    showStats: false,
    showStatusBar: true,
    height: 'h-[500px]',
    autoConnect: true,
  },
};

/**
 * Configuration without the status bar for embedding in other UI.
 */
export const WithoutStatusBar: Story = {
  args: {
    agentId: 'agent-demo-789',
    showStats: true,
    showStatusBar: false,
    height: 'h-[500px]',
    autoConnect: true,
  },
};

/**
 * Minimal configuration showing only messages.
 */
export const MessagesOnly: Story = {
  args: {
    agentId: 'agent-demo-minimal',
    showStats: false,
    showStatusBar: false,
    height: 'h-[400px]',
    autoConnect: true,
  },
};

/**
 * Taller configuration for full-page views.
 */
export const TallView: Story = {
  args: {
    agentId: 'agent-demo-tall',
    showStats: true,
    showStatusBar: true,
    height: 'h-[800px]',
    autoConnect: true,
  },
};

/**
 * Short configuration for dashboard widgets.
 */
export const ShortView: Story = {
  args: {
    agentId: 'agent-demo-short',
    showStats: true,
    showStatusBar: true,
    height: 'h-[300px]',
    autoConnect: true,
  },
};

/**
 * Auto-connect disabled - requires manual connection trigger.
 */
export const ManualConnect: Story = {
  args: {
    agentId: 'agent-demo-manual',
    showStats: true,
    showStatusBar: true,
    height: 'h-[500px]',
    autoConnect: false,
  },
};

// =============================================================================
// CompactAgentActivity Stories
// =============================================================================

/**
 * Compact version of AgentActivity for space-constrained layouts.
 * Shows fewer messages and uses inline stats.
 */
export const Compact: Story = {
  args: {
    agentId: 'agent-demo-compact',
  },
  render: () => <CompactAgentActivity agentId="agent-demo-compact" maxMessages={10} />,
};

export const CompactFewMessages: Story = {
  args: {
    agentId: 'agent-demo-compact-few',
  },
  render: () => <CompactAgentActivity agentId="agent-demo-compact-few" maxMessages={5} />,
};

export const CompactManyMessages: Story = {
  args: {
    agentId: 'agent-demo-compact-many',
  },
  render: () => <CompactAgentActivity agentId="agent-demo-compact-many" maxMessages={20} />,
};

// =============================================================================
// Layout Examples
// =============================================================================

export const DashboardLayout: Story = {
  args: {
    agentId: 'agent-demo-dashboard',
  },
  render: () => (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <h3 className="text-sm font-medium mb-2">Worker Agent 1</h3>
        <CompactAgentActivity agentId="worker-1" maxMessages={5} />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Worker Agent 2</h3>
        <CompactAgentActivity agentId="worker-2" maxMessages={5} />
      </div>
      <div className="col-span-2">
        <h3 className="text-sm font-medium mb-2">Supervisor Agent</h3>
        <AgentActivity
          agentId="supervisor-1"
          showStats={true}
          showStatusBar={true}
          height="h-[300px]"
        />
      </div>
    </div>
  ),
};

export const SidePanelLayout: Story = {
  args: {
    agentId: 'agent-demo-sidepanel',
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
        <AgentActivity
          agentId="side-panel-agent"
          showStats={false}
          showStatusBar={true}
          height="h-[400px]"
        />
      </div>
    </div>
  ),
};
