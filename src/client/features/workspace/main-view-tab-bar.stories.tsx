import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { SubagentSelection } from '@/client/features/subagents';
import { MainViewTabBar } from './main-view-tab-bar';
import type { WorkspaceSessionRuntimeSummary } from './session-tab-runtime';
import { useWorkspacePanel, WorkspacePanelProvider } from './workspace-panel-context';

const runningSelection: SubagentSelection = {
  parentSessionId: 'session-1',
  parentSessionName: 'Chat 1',
  subagent: {
    id: 'child-1',
    name: 'Security review',
    status: 'running',
    createdAt: '2026-08-10T10:00:00.000Z',
    updatedAt: '2026-08-10T10:01:00.000Z',
    completedAt: null,
    latestActivity: 'Inspecting authentication boundaries',
    resultPreview: null,
  },
};

interface SubagentTabBarStoryProps {
  selection: SubagentSelection;
}

function SubagentTabBarStory({
  selection,
  workspaceId,
}: SubagentTabBarStoryProps & { workspaceId: string }) {
  const { openSubagentTab } = useWorkspacePanel();

  useEffect(() => {
    openSubagentTab(selection);
  }, [openSubagentTab, selection]);

  return <MainViewTabBar workspaceId={workspaceId} sessions={[]} />;
}

function SubagentTabBarStoryFrame({ selection }: SubagentTabBarStoryProps) {
  const [panelHydrated, setPanelHydrated] = useState(false);
  const workspaceId = `subagent-tab-story-${selection.subagent.status}`;

  useEffect(() => {
    setPanelHydrated(true);
  }, []);

  return (
    <WorkspacePanelProvider workspaceId={workspaceId}>
      {panelHydrated && <SubagentTabBarStory selection={selection} workspaceId={workspaceId} />}
    </WorkspacePanelProvider>
  );
}

const meta = {
  title: 'Workspace/MainViewTabBar',
  component: SubagentTabBarStoryFrame,
  parameters: { layout: 'fullscreen' },
  args: { selection: runningSelection },
} satisfies Meta<typeof SubagentTabBarStoryFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RunningSubagent: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Sub-agent tabs use the same botanical icon and color as the session sub-agent list.',
      },
    },
  },
};

export const CompletedSubagent: Story = {
  args: {
    selection: {
      ...runningSelection,
      subagent: {
        ...runningSelection.subagent,
        status: 'completed',
        completedAt: '2026-08-10T10:05:00.000Z',
        latestActivity: null,
        resultPreview: 'No privilege boundary issues found.',
      },
    },
  },
};

function ScreenshotTabBarStory() {
  const { openTab, tabs, activeTabId } = useWorkspacePanel();
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  return (
    <>
      <button type="button" onClick={() => openTab('screenshot', '/tmp/capture.png', 'Capture')}>
        Open screenshot
      </button>
      <MainViewTabBar workspaceId="screenshot-tab-story" sessions={[]} />
      <output>{activeTab?.path}</output>
    </>
  );
}

export const ScreenshotTab: Story = {
  render: () => (
    <WorkspacePanelProvider workspaceId="screenshot-tab-story">
      <ScreenshotTabBarStory />
    </WorkspacePanelProvider>
  ),
};

export const WithSessions: Story = {
  render: () => (
    <WorkspacePanelProvider workspaceId="sessions-story">
      <MainViewTabBar
        workspaceId="sessions-story"
        sessions={[
          { id: 'existing', name: 'Chat 1', status: 'RUNNING', provider: 'CODEX' },
          { id: 'second', name: 'Chat 2', status: 'IDLE', provider: 'CODEX' },
          {
            id: 'agent',
            name: 'Periodic task',
            workflow: 'periodic-task',
            status: 'RUNNING',
            provider: 'CODEX',
          },
        ]}
        currentSessionId="existing"
        onCreateSession={fn()}
        onRestartSession={fn()}
      />
    </WorkspacePanelProvider>
  ),
};

export const AgentStates: Story = {
  render: () => (
    <WorkspacePanelProvider workspaceId="agent-status-states">
      <MainViewTabBar
        workspaceId="agent-status-states"
        sessions={[
          ...(['IDLE', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED'] as const).map((status) => ({
            id: status,
            name: `Agent ${status.toLowerCase()}`,
            workflow: 'periodic-task',
            status,
          })),
          { id: 'loading', name: 'Agent loading', workflow: 'periodic-task', status: 'IDLE' },
        ]}
        sessionSummariesById={
          new Map([
            [
              'loading',
              {
                sessionId: 'loading',
                name: 'Agent loading',
                workflow: 'periodic-task',
                model: 'sonnet',
                persistedStatus: 'IDLE',
                runtimePhase: 'loading',
                processState: 'unknown',
                activity: 'IDLE',
                updatedAt: '2026-10-29T00:00:00Z',
                lastExit: null,
              },
            ],
          ])
        }
      />
    </WorkspacePanelProvider>
  ),
};

const closeSession = fn();

const workingSummary: WorkspaceSessionRuntimeSummary = {
  sessionId: 'working',
  name: 'Refactor auth',
  workflow: null,
  model: 'sonnet',
  persistedStatus: 'RUNNING',
  runtimePhase: 'running',
  processState: 'alive',
  activity: 'WORKING',
  updatedAt: '2026-11-03T00:00:00Z',
  lastExit: null,
};

function CloseGuardTabBar({ queuedMessageCount = 0 }: { queuedMessageCount?: number }) {
  return (
    <WorkspacePanelProvider workspaceId="close-guard-story">
      <MainViewTabBar
        workspaceId="close-guard-story"
        sessions={[
          { id: 'working', name: 'Refactor auth', status: 'RUNNING', provider: 'CLAUDE' },
          { id: 'idle', name: 'Docs pass', status: 'IDLE', provider: 'CLAUDE' },
        ]}
        currentSessionId={queuedMessageCount > 0 ? 'idle' : 'working'}
        queuedMessageCount={
          queuedMessageCount > 0 ? { sessionId: 'idle', count: queuedMessageCount } : null
        }
        sessionSummariesById={new Map([['working', workingSummary]])}
        onCloseSession={closeSession}
      />
    </WorkspacePanelProvider>
  );
}

export const CloseRunningSessionConfirms: Story = {
  render: () => <CloseGuardTabBar />,
  parameters: {
    docs: {
      description: {
        story:
          'Closing a working session asks for confirmation because it stops the agent; Cancel keeps the session.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    closeSession.mockClear();
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Close Refactor auth' }));
    const dialog = await page.findByRole('alertdialog');
    await expect(dialog).toHaveTextContent('Refactor auth is still working');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(page.queryByRole('alertdialog')).toBeNull());
    await expect(closeSession).not.toHaveBeenCalled();

    await userEvent.click(canvas.getByRole('button', { name: 'Close Refactor auth' }));
    await userEvent.click(
      within(await page.findByRole('alertdialog')).getByRole('button', { name: 'Stop and close' })
    );
    await expect(closeSession).toHaveBeenCalledWith('working');
  },
};

export const CloseIdleSessionImmediately: Story = {
  render: () => <CloseGuardTabBar />,
  parameters: {
    docs: {
      description: { story: 'Idle sessions with nothing queued close without a prompt.' },
    },
  },
  play: async ({ canvasElement }) => {
    closeSession.mockClear();
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Close Docs pass' }));
    await expect(closeSession).toHaveBeenCalledWith('idle');
    await expect(within(canvasElement.ownerDocument.body).queryByRole('alertdialog')).toBeNull();
  },
};

export const CloseSessionWithQueuedMessagesConfirms: Story = {
  render: () => <CloseGuardTabBar queuedMessageCount={2} />,
  parameters: {
    docs: {
      description: {
        story: 'An idle session with unsent queued messages confirms before discarding them.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    closeSession.mockClear();
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Close Docs pass' }));
    const dialog = await within(canvasElement.ownerDocument.body).findByRole('alertdialog');
    await expect(dialog).toHaveTextContent('2 queued messages');
    await expect(closeSession).not.toHaveBeenCalled();
  },
};
