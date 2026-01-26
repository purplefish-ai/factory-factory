import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import type { SessionData } from './session-tab-bar';
import { SessionTabBar } from './session-tab-bar';

const meta = {
  title: 'Chat/SessionTabBar',
  component: SessionTabBar,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    sessions: {
      control: 'object',
      description: 'Array of sessions to display as tabs',
    },
    currentSessionId: {
      control: 'text',
      description: 'ID of the currently selected session',
    },
    runningSessionId: {
      control: 'text',
      description: 'ID of the session that is currently processing',
    },
    onSelectSession: {
      action: 'onSelectSession',
      description: 'Callback when a session tab is clicked',
    },
    onCreateSession: {
      action: 'onCreateSession',
      description: 'Callback when the plus button is clicked',
    },
    onCloseSession: {
      action: 'onCloseSession',
      description: 'Callback when a tab close button is clicked',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the tab bar is disabled',
    },
  },
  args: {
    onSelectSession: fn(),
    onCreateSession: fn(),
    onCloseSession: fn(),
  },
} satisfies Meta<typeof SessionTabBar>;

export default meta;
type Story = StoryObj<typeof meta>;

// Helper to create session data
function createSession(
  id: string,
  offsetMinutes: number,
  options: Partial<SessionData> = {}
): SessionData {
  const now = new Date();
  const createdAt = new Date(now.getTime() - offsetMinutes * 60 * 1000);
  return {
    id,
    claudeSessionId: `claude-${id}`,
    status: 'IDLE',
    name: null,
    createdAt,
    ...options,
  };
}

export const NoSessions: Story = {
  args: {
    sessions: [],
    currentSessionId: null,
  },
  parameters: {
    docs: {
      description: {
        story: 'When there are no sessions, a placeholder message is shown with the plus button.',
      },
    },
  },
};

export const SingleSession: Story = {
  args: {
    sessions: [createSession('session-1', 60)],
    currentSessionId: 'session-1',
  },
  parameters: {
    docs: {
      description: {
        story: 'A single session displayed as a tab. Auto-generated name "Session 1" is used.',
      },
    },
  },
};

export const MultipleSessions: Story = {
  args: {
    sessions: [
      createSession('session-1', 180),
      createSession('session-2', 120),
      createSession('session-3', 60),
    ],
    currentSessionId: 'session-2',
  },
  parameters: {
    docs: {
      description: {
        story:
          'Multiple sessions with the second one selected. Sessions are numbered by creation order.',
      },
    },
  },
};

export const WithNamedSessions: Story = {
  args: {
    sessions: [
      createSession('session-1', 180, { name: 'Bug Fix' }),
      createSession('session-2', 120, { name: 'Feature Work' }),
      createSession('session-3', 60, { name: 'Refactoring' }),
    ],
    currentSessionId: 'session-2',
  },
  parameters: {
    docs: {
      description: {
        story: 'Sessions can have custom names that override the auto-generated numbering.',
      },
    },
  },
};

export const RunningSession: Story = {
  args: {
    sessions: [
      createSession('session-1', 180),
      createSession('session-2', 120, { status: 'RUNNING' }),
      createSession('session-3', 60),
    ],
    currentSessionId: 'session-2',
    runningSessionId: 'session-2',
  },
  parameters: {
    docs: {
      description: {
        story:
          'A running session shows a pulsing yellow indicator. The tab bar may be disabled during processing.',
      },
    },
  },
};

export const MixedStatuses: Story = {
  args: {
    sessions: [
      createSession('session-1', 240, { status: 'COMPLETED' }),
      createSession('session-2', 180, { status: 'FAILED' }),
      createSession('session-3', 120, { status: 'PAUSED' }),
      createSession('session-4', 60, { status: 'IDLE' }),
    ],
    currentSessionId: 'session-4',
  },
  parameters: {
    docs: {
      description: {
        story:
          'Different session statuses show different indicator colors: green (idle), yellow (running), blue (completed), red (failed), gray (paused).',
      },
    },
  },
};

export const ManySessions: Story = {
  args: {
    sessions: [
      createSession('session-1', 480),
      createSession('session-2', 420),
      createSession('session-3', 360),
      createSession('session-4', 300),
      createSession('session-5', 240),
      createSession('session-6', 180),
      createSession('session-7', 120),
      createSession('session-8', 60),
    ],
    currentSessionId: 'session-4',
  },
  decorators: [
    (Story) => (
      <div style={{ width: '400px' }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        story:
          'When there are many sessions, the tab bar becomes scrollable. Scroll arrows appear when needed.',
      },
    },
  },
};

export const DisabledState: Story = {
  args: {
    sessions: [
      createSession('session-1', 180),
      createSession('session-2', 120),
      createSession('session-3', 60),
    ],
    currentSessionId: 'session-2',
    disabled: true,
  },
  parameters: {
    docs: {
      description: {
        story: 'The tab bar can be disabled to prevent interaction during loading or processing.',
      },
    },
  },
};
