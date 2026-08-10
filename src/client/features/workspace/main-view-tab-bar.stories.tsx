import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState } from 'react';
import { fn } from 'storybook/test';
import type { SubagentSelection } from '@/client/features/subagents';
import { MainViewTabBar } from './main-view-tab-bar';
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

  return (
    <MainViewTabBar
      workspaceId={workspaceId}
      sessions={[]}
      selectedProvider="CODEX"
      setSelectedProvider={fn()}
    />
  );
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
  title: 'Workspace/MainViewTabBar/Subagent',
  component: SubagentTabBarStoryFrame,
  parameters: { layout: 'fullscreen' },
  args: { selection: runningSelection },
} satisfies Meta<typeof SubagentTabBarStoryFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RunningSubagent: Story = {};

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
