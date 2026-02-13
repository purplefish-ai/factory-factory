import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { WorkspaceContentView } from './workspace-content-view';
import { WorkspacePanelProvider } from './workspace-panel-context';

const meta = {
  title: 'Workspace/WorkspaceContentView',
  component: WorkspaceContentView,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story, context) => (
      <WorkspacePanelProvider workspaceId={context.args.workspaceId}>
        <Story />
      </WorkspacePanelProvider>
    ),
  ],
  tags: ['autodocs'],
  args: {
    workspaceId: 'workspace-1',
    sessions: [],
    selectedSessionId: null,
    sessionSummariesById: new Map(),
    isCreatingSession: false,
    isDeletingSession: false,
    onSelectSession: fn(),
    onCreateSession: fn(),
    onCloseSession: fn(),
    maxSessions: 5,
    hasWorktreePath: true,
    selectedProvider: 'WORKSPACE_DEFAULT',
    setSelectedProvider: fn(),
    effectiveDefaultProvider: 'CLAUDE',
    children: <div className="p-4">Chat content</div>,
  },
} satisfies Meta<typeof WorkspaceContentView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoSessions: Story = {
  args: {},
};

export const NoSessionsInitializing: Story = {
  args: {
    sessions: [],
    hasWorktreePath: false,
  },
};
