import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { createSessionInfo } from '@/lib/claude-fixtures';

import { SessionPicker } from './session-picker';

const meta = {
  title: 'Chat/SessionPicker',
  component: SessionPicker,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    sessions: {
      control: 'object',
      description: 'Array of available sessions',
    },
    currentSessionId: {
      control: 'text',
      description: 'ID of the currently active session',
    },
    onLoadSession: {
      action: 'onLoadSession',
      description: 'Callback when a session is selected',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the picker is disabled',
    },
    className: {
      control: 'text',
      description: 'Additional CSS classes',
    },
  },
  args: {
    onLoadSession: fn(),
  },
} satisfies Meta<typeof SessionPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

// Helper to create sessions with different timestamps
function createSessionWithOffset(sessionId: string, offsetMinutes: number, sizeBytes: number) {
  const now = new Date();
  const modified = new Date(now.getTime() - offsetMinutes * 60 * 1000);
  const created = new Date(modified.getTime() - 60 * 60 * 1000); // 1 hour before modified
  return createSessionInfo({
    sessionId,
    createdAt: created.toISOString(),
    modifiedAt: modified.toISOString(),
    sizeBytes,
  });
}

export const NoSessions: Story = {
  args: {
    sessions: [],
    currentSessionId: null,
  },
  parameters: {
    docs: {
      description: {
        story:
          'When there are no sessions, a placeholder message is shown instead of the dropdown.',
      },
    },
  },
};

export const SingleSession: Story = {
  args: {
    sessions: [createSessionWithOffset('abc123def456', 5, 12_288)],
    currentSessionId: null,
  },
};

export const MultipleSessions: Story = {
  args: {
    sessions: [
      createSessionWithOffset('session-a1b2c3d4e5f6', 2, 8192),
      createSessionWithOffset('session-g7h8i9j0k1l2', 30, 24_576),
      createSessionWithOffset('session-m3n4o5p6q7r8', 120, 45_056),
      createSessionWithOffset('session-s9t0u1v2w3x4', 1440, 102_400),
      createSessionWithOffset('session-y5z6a7b8c9d0', 10_080, 256_000),
    ],
    currentSessionId: null,
  },
  parameters: {
    docs: {
      description: {
        story: 'Multiple sessions are sorted by modification date, with the most recent first.',
      },
    },
  },
};

export const CurrentSessionSelected: Story = {
  args: {
    sessions: [
      createSessionWithOffset('session-current-1234', 5, 15_360),
      createSessionWithOffset('session-older-5678', 60, 32_768),
      createSessionWithOffset('session-oldest-9012', 180, 8192),
    ],
    currentSessionId: 'session-current-1234',
  },
  parameters: {
    docs: {
      description: {
        story: 'The current session is highlighted and marked with "(current)" in the dropdown.',
      },
    },
  },
};

export const DisabledState: Story = {
  args: {
    sessions: [
      createSessionWithOffset('session-disabled-1', 10, 16_384),
      createSessionWithOffset('session-disabled-2', 45, 24_576),
    ],
    currentSessionId: 'session-disabled-1',
    disabled: true,
  },
  parameters: {
    docs: {
      description: {
        story: 'The picker can be disabled to prevent interaction while loading or processing.',
      },
    },
  },
};
