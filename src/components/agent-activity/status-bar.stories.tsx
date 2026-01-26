import type { Meta, StoryObj } from '@storybook/react';
import { createAgentMetadata } from '@/lib/claude-fixtures';
import { MinimalStatus, StatusBar } from './status-bar';

// Helper for story actions
const noop = () => {
  /* action handler */
};

const meta = {
  title: 'AgentActivity/StatusBar',
  component: StatusBar,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    connectionState: {
      control: 'select',
      options: ['connecting', 'connected', 'disconnected', 'error'],
      description: 'Current WebSocket connection state',
    },
    running: {
      control: 'boolean',
      description: 'Whether the agent is currently running',
    },
    error: {
      control: 'text',
      description: 'Error message to display',
    },
  },
} satisfies Meta<typeof StatusBar>;

export default meta;
type Story = StoryObj<typeof meta>;

// =============================================================================
// Connection State Stories
// =============================================================================

export const Connecting: Story = {
  args: {
    connectionState: 'connecting',
    running: false,
    agentMetadata: null,
    error: null,
  },
};

export const Connected: Story = {
  args: {
    connectionState: 'connected',
    running: false,
    agentMetadata: null,
    error: null,
  },
};

export const Disconnected: Story = {
  args: {
    connectionState: 'disconnected',
    running: false,
    agentMetadata: null,
    error: null,
    onReconnect: noop,
  },
};

export const ErrorState: Story = {
  args: {
    connectionState: 'error',
    running: false,
    agentMetadata: null,
    error: 'WebSocket connection failed: timeout after 30s',
    onReconnect: noop,
  },
};

// =============================================================================
// Agent State Stories
// =============================================================================

export const RunningWithMetadata: Story = {
  args: {
    connectionState: 'connected',
    running: true,
    agentMetadata: createAgentMetadata({
      type: 'WORKER',
      executionState: 'RUNNING',
      isHealthy: true,
      currentTask: {
        id: 'task-123',
        title: 'Implement user authentication',
        state: 'IN_PROGRESS',
        branchName: 'feature/user-auth',
        prUrl: null,
      },
    }),
    error: null,
  },
};

export const Paused: Story = {
  args: {
    connectionState: 'connected',
    running: false,
    agentMetadata: createAgentMetadata({
      type: 'WORKER',
      executionState: 'paused',
      isHealthy: true,
      currentTask: {
        id: 'task-456',
        title: 'Refactor database layer',
        state: 'PAUSED',
        branchName: 'feature/db-refactor',
        prUrl: null,
      },
    }),
    error: null,
  },
};

export const Stopped: Story = {
  args: {
    connectionState: 'connected',
    running: false,
    agentMetadata: createAgentMetadata({
      type: 'SUPERVISOR',
      executionState: 'stopped',
      isHealthy: true,
      currentTask: null,
    }),
    error: null,
  },
};

export const Pending: Story = {
  args: {
    connectionState: 'connected',
    running: false,
    agentMetadata: createAgentMetadata({
      type: 'WORKER',
      executionState: 'pending',
      isHealthy: true,
      currentTask: {
        id: 'task-789',
        title: 'Waiting for dependencies',
        state: 'PENDING',
        branchName: null,
        prUrl: null,
      },
    }),
    error: null,
  },
};

export const AgentError: Story = {
  args: {
    connectionState: 'connected',
    running: false,
    agentMetadata: createAgentMetadata({
      type: 'WORKER',
      executionState: 'error',
      isHealthy: false,
      currentTask: {
        id: 'task-error',
        title: 'Failed task',
        state: 'ERROR',
        branchName: 'feature/broken',
        prUrl: null,
      },
    }),
    error: 'Agent encountered an error during execution',
  },
};

export const WithTaskInfo: Story = {
  args: {
    connectionState: 'connected',
    running: true,
    agentMetadata: createAgentMetadata({
      type: 'SUPERVISOR',
      executionState: 'RUNNING',
      isHealthy: true,
      currentTask: {
        id: 'task-super',
        title: 'Coordinating feature implementation across 3 workers',
        state: 'IN_PROGRESS',
        branchName: 'feature/new-feature',
        prUrl: 'https://github.com/org/repo/pull/42',
      },
    }),
    error: null,
  },
};

export const UnhealthyAgent: Story = {
  args: {
    connectionState: 'connected',
    running: false,
    agentMetadata: createAgentMetadata({
      type: 'WORKER',
      executionState: 'RUNNING',
      isHealthy: false,
      minutesSinceHeartbeat: 15,
      currentTask: {
        id: 'task-stale',
        title: 'Stale task',
        state: 'IN_PROGRESS',
        branchName: 'feature/stale',
        prUrl: null,
      },
    }),
    error: null,
  },
};

// =============================================================================
// Composite Stories
// =============================================================================

export const AllStates: Story = {
  args: {
    connectionState: 'connected',
    running: false,
    agentMetadata: null,
    error: null,
  },
  render: () => (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium mb-2">Connecting</h3>
        <StatusBar connectionState="connecting" running={false} agentMetadata={null} error={null} />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Connected (Idle)</h3>
        <StatusBar connectionState="connected" running={false} agentMetadata={null} error={null} />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Connected (Running)</h3>
        <StatusBar
          connectionState="connected"
          running={true}
          agentMetadata={createAgentMetadata({
            executionState: 'RUNNING',
            currentTask: {
              id: 'task-1',
              title: 'Active task',
              state: 'IN_PROGRESS',
              branchName: 'feature/active',
              prUrl: null,
            },
          })}
          error={null}
        />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Connected (Paused)</h3>
        <StatusBar
          connectionState="connected"
          running={false}
          agentMetadata={createAgentMetadata({
            executionState: 'paused',
            currentTask: {
              id: 'task-2',
              title: 'Paused task',
              state: 'PAUSED',
              branchName: 'feature/paused',
              prUrl: null,
            },
          })}
          error={null}
        />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Disconnected</h3>
        <StatusBar
          connectionState="disconnected"
          running={false}
          agentMetadata={null}
          error={null}
          onReconnect={noop}
        />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Error</h3>
        <StatusBar
          connectionState="error"
          running={false}
          agentMetadata={null}
          error="Connection timeout"
          onReconnect={noop}
        />
      </div>
    </div>
  ),
};

// =============================================================================
// MinimalStatus Stories
// =============================================================================

export const MinimalConnecting: Story = {
  args: {
    connectionState: 'connecting',
    running: false,
    agentMetadata: null,
    error: null,
  },
  render: () => (
    <div className="p-4">
      <MinimalStatus connectionState="connecting" running={false} />
    </div>
  ),
};

export const MinimalConnected: Story = {
  args: {
    connectionState: 'connected',
    running: false,
    agentMetadata: null,
    error: null,
  },
  render: () => (
    <div className="p-4">
      <MinimalStatus connectionState="connected" running={false} />
    </div>
  ),
};

export const MinimalRunning: Story = {
  args: {
    connectionState: 'connected',
    running: true,
    agentMetadata: null,
    error: null,
  },
  render: () => (
    <div className="p-4">
      <MinimalStatus connectionState="connected" running={true} />
    </div>
  ),
};

export const MinimalDisconnected: Story = {
  args: {
    connectionState: 'disconnected',
    running: false,
    agentMetadata: null,
    error: null,
  },
  render: () => (
    <div className="p-4">
      <MinimalStatus connectionState="disconnected" running={false} />
    </div>
  ),
};

export const AllMinimalStates: Story = {
  args: {
    connectionState: 'connected',
    running: false,
    agentMetadata: null,
    error: null,
  },
  render: () => (
    <div className="flex gap-8 p-4">
      <div className="flex flex-col items-center gap-2">
        <MinimalStatus connectionState="connecting" running={false} />
        <span className="text-xs text-muted-foreground">Connecting</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <MinimalStatus connectionState="connected" running={false} />
        <span className="text-xs text-muted-foreground">Connected</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <MinimalStatus connectionState="connected" running={true} />
        <span className="text-xs text-muted-foreground">Running</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <MinimalStatus connectionState="disconnected" running={false} />
        <span className="text-xs text-muted-foreground">Disconnected</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <MinimalStatus connectionState="error" running={false} />
        <span className="text-xs text-muted-foreground">Error</span>
      </div>
    </div>
  ),
};
