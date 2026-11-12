import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { RightPanelLayout } from './right-panel-layout';
import { resolveTopTab, type TopPanelTab } from './right-panel-state';
import { useWorkspacePanel, WorkspacePanelProvider } from './workspace-panel-context';

type Tool = TopPanelTab | 'terminal' | 'logs';

function ToolPreview({ initialTool }: { initialTool: Tool }) {
  const { mobilePanel, storedTopTab, activeBottomTab, setActiveTopTab, setActiveBottomTab } =
    useWorkspacePanel();
  const activeTopTab = resolveTopTab(storedTopTab, { periodicTaskId: 'periodic-task' });
  useEffect(() => {
    if (initialTool === 'terminal' || initialTool === 'logs') {
      setActiveBottomTab(initialTool === 'logs' ? 'setup-logs' : 'terminal');
    } else {
      setActiveTopTab(initialTool);
    }
  }, [initialTool, setActiveTopTab, setActiveBottomTab]);
  return (
    <RightPanelLayout
      workspaceId={`mobile-tools-${initialTool}`}
      isMobile
      mobilePanel={mobilePanel}
      activeTopTab={activeTopTab}
      showRuns
      onOpenLogs={() => setActiveBottomTab('setup-logs')}
      topPanel={<div className="p-4 text-sm text-muted-foreground">{activeTopTab} content</div>}
      bottomPanel={
        <div className="p-4 text-sm text-muted-foreground">{activeBottomTab} content</div>
      }
    />
  );
}

function HydratedToolPreview({ initialTool }: { initialTool: Tool }) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <WorkspacePanelProvider workspaceId={`mobile-tools-${initialTool}`}>
      {hydrated && <ToolPreview initialTool={initialTool} />}
    </WorkspacePanelProvider>
  );
}

function MobileToolsStory({
  initialTool = 'changes',
  width = 320,
}: {
  initialTool?: Tool;
  width?: number;
}) {
  return (
    <div style={{ width }} className="h-64 border bg-background">
      <HydratedToolPreview key={initialTool} initialTool={initialTool} />
    </div>
  );
}

const meta = {
  title: 'Workspace/MobileToolSwitcher',
  component: MobileToolsStory,
  args: { initialTool: 'changes', width: 320 },
} satisfies Meta<typeof MobileToolsStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Changes: Story = {};
export const Files: Story = { args: { initialTool: 'files' } };
export const Terminal: Story = { args: { initialTool: 'terminal' } };
export const Screenshots: Story = { args: { initialTool: 'screenshots' } };
export const Inbox: Story = { args: { initialTool: 'inbox' } };
export const Runs: Story = {
  args: { initialTool: 'periodic-task' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('tab', { name: 'Runs', selected: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'More tools' }));
    await expect(
      within(document.body).getByRole('menuitemradio', { name: 'Runs' })
    ).toHaveAttribute('aria-checked', 'true');
  },
};
export const Logs: Story = { args: { initialTool: 'logs' } };
export const Wide: Story = {
  args: { initialTool: 'agents', width: 640 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('tab', { name: 'Subagents', selected: true })
    ).toBeVisible();
  },
};
