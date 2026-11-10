import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { useRef, useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ChatTranscript } from '@/client/features/chat';
import type { SubagentSelection } from '@/client/features/subagents';
import { runInBackground } from '@/client/lib/background-task';
import { readStorageItem, removeStorageItem, writeStorageItem } from '@/client/lib/browser-storage';
import { trpc } from '@/client/lib/trpc';
import { invalidateWorkspaceDetail } from '@/client/lib/workspace-queries';
import { Button } from '@/components/ui/button';
import { MainViewTabBar } from './main-view-tab-bar';
import { RightPanel } from './right-panel';
import { useWorkspacePanel, WorkspacePanelProvider } from './workspace-panel-context';

const workspaceId = 'right-panel-capabilities-story';
const activitySelection: SubagentSelection = {
  parentSessionId: 'session-1',
  parentSessionName: 'Chat 1',
  subagent: {
    id: 'review',
    name: 'Review code',
    status: 'running',
    createdAt: null,
    updatedAt: null,
    completedAt: null,
    latestActivity: null,
    resultPreview: null,
  },
};
function RightPanelStory({
  hasTask = false,
  showChatToolbar = false,
  showActivity = false,
  showUnread = false,
}: {
  showUnread?: boolean;
  hasTask?: boolean;
  showChatToolbar?: boolean;
  showActivity?: boolean;
}) {
  const taskPresent = useRef(hasTask);
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              const responses: Record<string, () => unknown> = {
                'userSettings.get': () => ({ childWorkspacesEnabled: true }),
                'session.listSubagents': () => ({
                  supported: true,
                  subagents: [activitySelection.subagent],
                  nextCursor: null,
                }),
                'workspace.get': () => ({
                  id: workspaceId,
                  projectId: 'right-panel-project',
                  periodicTaskId: taskPresent.current ? 'task-1' : null,
                  creationSource: showActivity ? 'CHILD_WORKSPACE' : 'MANUAL',
                }),
                'workspace.unreadMailCounts': () => (showUnread ? { [workspaceId]: 3 } : {}),
                'workspace.getInitStatus': () => ({ status: 'READY', initOutput: '' }),
                'workspace.getGitStatus': () => ({ files: [] }),
                'workspace.getDiffVsMain': () => ({
                  added: [],
                  modified: [],
                  deleted: [],
                  noMergeBase: false,
                }),
                'workspace.getUnpushedFiles': () => ({ files: [], hasUpstream: true }),
                'periodicTask.get': () => ({
                  id: 'task-1',
                  projectId: 'right-panel-project',
                  scheduledTime: null,
                  timezone: null,
                  name: 'Scheduled cleanup',
                  prompt: 'Clean up completed work',
                  cadence: 'DAILY',
                  isEnabled: false,
                  lastRunAt: null,
                }),
                'periodicTask.listExecutions': () => [],
                'workspace.listChildren': () => [],
                'project.getById': () => ({
                  id: 'right-panel-project',
                  slug: 'demo',
                  name: 'Demo',
                }),
              };
              const respond = responses[op.path];
              if (!respond) {
                observer.error(new TRPCClientError(`Missing story fixture: ${op.path}`));
                return;
              }
              observer.next({ result: { data: respond() } });
              observer.complete();
            }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <WorkspacePanelProvider workspaceId={workspaceId}>
          {showActivity ? (
            <ActivityNavigation />
          ) : (
            <>
              <Button
                onClick={() => {
                  taskPresent.current = false;
                  runInBackground(
                    invalidateWorkspaceDetail(queryClient, workspaceId),
                    'Could not refresh workspace'
                  );
                }}
              >
                Delete automation
              </Button>
              <div
                className="flex h-[650px] border"
                style={{ width: showChatToolbar ? 1600 : 800 }}
              >
                {showChatToolbar && (
                  <div className="min-w-0 flex-1 border-r">
                    <div className="border-b" data-testid="chat-toolbar">
                      <MainViewTabBar
                        workspaceId={workspaceId}
                        sessions={[{ id: 'session-1', name: 'Chat 1', status: 'IDLE' }]}
                        currentSessionId="session-1"
                        onCreateSession={fn()}
                        onRestartSession={fn()}
                      />
                    </div>
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <RightPanel workspaceId={workspaceId} />
                </div>
              </div>
            </>
          )}
        </WorkspacePanelProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

function ActivityNavigation() {
  const { rightPanelVisible, openSubagentTab } = useWorkspacePanel();
  return (
    <div className="flex h-[650px] w-[1000px] border">
      <div className="flex-1 p-4">
        <MainViewTabBar workspaceId={workspaceId} sessions={[]} />
        <ChatTranscript
          messages={[]}
          running
          loadingSession={false}
          startingSession={false}
          scroll={{
            identity: 'story',
            active: true,
            ready: true,
            initialIntent: 'following',
            initialPosition: null,
          }}
          work={{ promptInFlight: false, backgroundTasks: [], runningSubagents: 1, activeGoals: 0 }}
          onOpenSingleSubagent={() => openSubagentTab(activitySelection)}
        />
      </div>
      {rightPanelVisible && (
        <div className="flex-1 border-l">
          <RightPanel workspaceId={workspaceId} />
        </div>
      )}
    </div>
  );
}

// Keep terminal/log channels disconnected in this local fixture.
class StorySocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  close() {
    this.readyState = 3;
  }
  send() {
    /* Offline story channels do not transmit messages. */
  }
}
const meta = {
  title: 'Workspace/RightPanel',
  component: RightPanelStory,
  parameters: { layout: 'padded' },
  beforeEach: () => {
    const socket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: StorySocket,
    });
    const entries = [
      [`workspace-right-panel-tab-${workspaceId}`, 'periodic-task'],
      [`workspace-panel-bottom-tab-${workspaceId}`, 'setup-logs'],
      [`workspace-panel-right-visible-${workspaceId}`, 'false'],
      [`workspace-panel-tabs-${workspaceId}`, '[]'],
      [`workspace-panel-active-tab-${workspaceId}`, 'chat'],
    ];
    const previous = entries.map(([key]) => [key, readStorageItem(key ?? '')]);
    for (const [key, value] of entries) {
      if (key && value) {
        writeStorageItem(key, value);
      }
    }
    return () => {
      if (socket) {
        Object.defineProperty(globalThis, 'WebSocket', socket);
      }
      for (const [key, value] of previous) {
        if (!key) {
          continue;
        }
        if (value == null) {
          removeStorageItem(key);
        } else {
          writeStorageItem(key, value);
        }
      }
    };
  },
} satisfies Meta<typeof RightPanelStory>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Stored panel layout renders as saved, and mounting does not rewrite it. */
export const RestoresStoredLayout: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Log source')).toBeVisible();
    await expect(readStorageItem(`workspace-panel-bottom-tab-${workspaceId}`)).toBe('setup-logs');
    await expect(readStorageItem(`workspace-panel-tabs-${workspaceId}`)).toBe('[]');
    await expect(readStorageItem(`workspace-panel-right-visible-${workspaceId}`)).toBe('false');
  },
};

export const LegacyIterationPreference: Story = {
  beforeEach: () => {
    writeStorageItem(`workspace-right-panel-tab-${workspaceId}`, 'auto-iteration');
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No changes')).toBeVisible();
    await expect(canvas.queryByRole('tab', { name: 'Iterations' })).not.toBeInTheDocument();
    // Reading a retired preference does not rewrite it; the next selection does.
    await expect(readStorageItem(`workspace-right-panel-tab-${workspaceId}`)).toBe(
      'auto-iteration'
    );
  },
};
export const DeletedTaskPreference: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No changes')).toBeVisible();
    await expect(canvas.queryByRole('tab', { name: 'Runs' })).not.toBeInTheDocument();
    // Changes is shown; the stored choice stays until the user picks a tab.
    await expect(readStorageItem(`workspace-right-panel-tab-${workspaceId}`)).toBe('periodic-task');
  },
};
export const DeleteWhileOpen: Story = {
  args: { hasTask: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Scheduled cleanup');
    await userEvent.click(canvas.getByRole('button', { name: 'Delete automation' }));
    await expect(await canvas.findByText('No changes')).toBeVisible();
    // Changes is shown; the stored choice stays until the user picks a tab.
    await expect(readStorageItem(`workspace-right-panel-tab-${workspaceId}`)).toBe('periodic-task');
  },
};

/**
 * Tool tab labels follow the glossary in docs/workspaces.md: the scheduled-automation
 * origin panel is "Runs" (not the chat's coding agent), and the
 * subagent/child-workspace panel is "Subagents" (not chat sessions). With no
 * chat selected, that panel shows only Child workspaces.
 */
export const ToolTabLabels: Story = {
  args: { hasTask: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Scheduled cleanup');
    await expect(canvas.getByRole('tab', { name: 'Runs' })).toBeVisible();
    await expect(canvas.queryByRole('tab', { name: 'Agent' })).not.toBeInTheDocument();
    await expect(canvas.queryByRole('tab', { name: 'Sessions' })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('tab', { name: 'Subagents' }));
    await expect(canvas.getByRole('tab', { name: 'Subagents' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    // The icon-only Screenshots tab is part of the same tablist.
    const tools = canvas.getByRole('tablist', { name: 'Workspace tools' });
    await expect(within(tools).getByRole('tab', { name: 'Screenshots' })).toBeVisible();
    await expect(await canvas.findByText('Child workspaces')).toBeVisible();
    await expect(await canvas.findByText('No child workspaces yet')).toBeVisible();
  },
};

export const AlignedToolbars: Story = {
  args: { showChatToolbar: true },
  globals: { theme: 'dark' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('No changes');
    const chatToolbar = canvas.getByTestId('chat-toolbar');
    const changesToolbar = canvas.getByTestId('workspace-tools-toolbar');
    const chatBounds = chatToolbar.getBoundingClientRect();
    const changesBounds = changesToolbar.getBoundingClientRect();
    await expect(chatBounds.top).toBe(changesBounds.top);
    await expect(chatBounds.bottom).toBe(changesBounds.bottom);
  },
};

export const OpenSubagentFromActivity: Story = {
  args: { showActivity: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '1 subagent running' }));
    await expect(canvas.getByRole('tab', { name: /Review code/, selected: true })).toBeVisible();
    await expect(canvas.queryByRole('tab', { name: 'Subagents' })).not.toBeInTheDocument();
    await expect(readStorageItem(`workspace-panel-right-visible-${workspaceId}`)).toBe('false');
  },
};

export const UnreadInbox: Story = {
  render: () => <RightPanelStory showUnread />,
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole('img', { name: '3 unread inbox messages' })
    ).toBeVisible();
  },
};

export const UnreadInboxDark: Story = { ...UnreadInbox, globals: { theme: 'dark' } };
export const UnreadInboxPhone: Story = {
  ...UnreadInbox,
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('img', { name: '3 unread inbox messages' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /More tools/ }));
    const inbox = await within(canvasElement.ownerDocument.body).findByRole('menuitemradio', {
      name: /Inbox/,
    });
    await expect(within(inbox).getByRole('img', { name: '3 unread inbox messages' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
  },
};
