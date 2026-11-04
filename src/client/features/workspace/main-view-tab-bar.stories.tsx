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

export const AgentStatesDark: typeof AgentStates = { ...AgentStates, globals: { theme: 'dark' } };

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

function sessionSummary(
  sessionId: string,
  overrides: Partial<WorkspaceSessionRuntimeSummary> = {}
): WorkspaceSessionRuntimeSummary {
  return {
    sessionId,
    name: sessionId,
    workflow: null,
    model: 'sonnet',
    persistedStatus: 'RUNNING',
    runtimePhase: 'running',
    processState: 'alive',
    activity: 'WORKING',
    updatedAt: '2026-11-04T00:00:00Z',
    lastExit: null,
    ...overrides,
  };
}

function AwaitingInputTabBar() {
  return (
    <WorkspacePanelProvider workspaceId="awaiting-input-story">
      <MainViewTabBar
        workspaceId="awaiting-input-story"
        sessions={[
          { id: 'permission', name: 'Migrate schema', status: 'RUNNING', provider: 'CLAUDE' },
          { id: 'question', name: 'Pick a branch', status: 'RUNNING', provider: 'CLAUDE' },
          { id: 'plan', name: 'Plan refactor', status: 'RUNNING', provider: 'CLAUDE' },
          { id: 'ci', name: 'Fix CI', workflow: 'ci-fix', status: 'RUNNING', provider: 'CLAUDE' },
          { id: 'working', name: 'Write docs', status: 'RUNNING', provider: 'CLAUDE' },
          { id: 'idle', name: 'Docs pass', status: 'IDLE', provider: 'CLAUDE' },
        ]}
        currentSessionId="permission"
        sessionSummariesById={
          new Map([
            [
              'permission',
              sessionSummary('permission', { pendingRequestType: 'permission_request' }),
            ],
            ['question', sessionSummary('question', { pendingRequestType: 'user_question' })],
            ['plan', sessionSummary('plan', { pendingRequestType: 'plan_approval' })],
            [
              'ci',
              sessionSummary('ci', {
                workflow: 'ci-fix',
                pendingRequestType: 'permission_request',
              }),
            ],
            ['working', sessionSummary('working')],
            [
              'idle',
              sessionSummary('idle', {
                persistedStatus: 'IDLE',
                runtimePhase: 'idle',
                activity: 'IDLE',
              }),
            ],
          ])
        }
        onCreateSession={fn()}
      />
    </WorkspacePanelProvider>
  );
}

export const AwaitingInput: Story = {
  render: () => <AwaitingInputTabBar />,
  parameters: {
    docs: {
      description: {
        story:
          'Sessions blocked on a permission request, a question or a plan approval use the "needs you" tone with an icon per request kind, instead of the running pulse. A blocked CI-fix session swaps its wrench for the request icon.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const approval = canvas.getAllByRole('img', { name: 'Needs approval' });
    await expect(approval).toHaveLength(2);
    for (const icon of approval) {
      await expect(icon).toHaveClass('text-warning');
      await expect(icon).not.toHaveClass('animate-pulse');
    }
    await expect(canvas.getByRole('img', { name: 'Needs answer' })).toHaveClass('text-warning');
    await expect(canvas.getByRole('img', { name: 'Needs plan review' })).toHaveClass(
      'text-warning'
    );
    await expect(canvas.getByRole('img', { name: 'Running' })).toHaveClass('animate-pulse');
    await expect(canvas.getByRole('img', { name: 'Idle' })).toBeInTheDocument();

    await userEvent.hover(approval[0] as HTMLElement);
    await expect(
      await within(canvasElement.ownerDocument.body).findByRole('tooltip')
    ).toHaveTextContent('Waiting for your permission to continue');
  },
};

export const AwaitingInputDark: Story = {
  render: () => <AwaitingInputTabBar />,
  globals: { theme: 'dark' },
};

export const RenameChatInline: Story = {
  parameters: { trpc: { handlers: { 'session.updateSession': () => ({}) } } },
  render: () => (
    <WorkspacePanelProvider workspaceId="rename-chat-story">
      <MainViewTabBar
        workspaceId="rename-chat-story"
        sessions={[{ id: 'session-rename', name: 'Chat 1', status: 'IDLE' }]}
        currentSessionId="session-rename"
        onRestartSession={fn()}
      />
    </WorkspacePanelProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Chat actions' }));
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole('menuitem', { name: 'Rename chat' })
    );
    const input = await canvas.findByRole('textbox', { name: 'Chat name' });
    await expect(input).toHaveFocus();
    await userEvent.clear(input);
    await userEvent.type(input, 'Review API{Enter}');
    await waitFor(() => expect(canvas.queryByRole('textbox')).not.toBeInTheDocument());
    await expect(canvas.getByRole('tab', { name: /Chat 1/ })).toBeVisible();
  },
};
