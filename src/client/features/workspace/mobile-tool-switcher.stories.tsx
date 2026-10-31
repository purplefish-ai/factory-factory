import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState } from 'react';
import { RightPanelLayout } from './right-panel-layout';
import type { TopPanelTab } from './right-panel-state';
import { useWorkspacePanel, WorkspacePanelProvider } from './workspace-panel-context';

type Tool = TopPanelTab | 'terminal' | 'logs';

function ToolPreview({ initialTool }: { initialTool: Tool }) {
  const { mobilePanel, activeTopTab, activeBottomTab, setActiveTopTab, setActiveBottomTab } =
    useWorkspacePanel();
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
      periodicTaskId="periodic-task"
      onOpenLogs={() => setActiveBottomTab('setup-logs')}
      topPanel={<div className="p-4 text-sm text-muted-foreground">{activeTopTab} content</div>}
      bottomPanel={
        <div className="p-4 text-sm text-muted-foreground">{activeBottomTab} content</div>
      }
    />
  );
}

function MobileToolsStory({
  initialTool = 'changes',
  width = 320,
}: {
  initialTool?: Tool;
  width?: number;
}) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <div style={{ width }} className="h-64 border bg-background">
      <WorkspacePanelProvider key={initialTool} workspaceId={`mobile-tools-${initialTool}`}>
        {hydrated && <ToolPreview initialTool={initialTool} />}
      </WorkspacePanelProvider>
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
export const Agent: Story = { args: { initialTool: 'periodic-task' } };
export const Logs: Story = { args: { initialTool: 'logs' } };
export const Wide: Story = { args: { initialTool: 'agents', width: 640 } };
