import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Button } from './button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './resizable';

const meta = {
  title: 'UI/Resizable',
  component: ResizablePanelGroup,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ResizablePanelGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

function WorkspaceSplitDemo() {
  const [workspace, setWorkspace] = useState('A');
  const [visible, setVisible] = useState(true);
  const [visit, setVisit] = useState(0);

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center gap-3 border-b p-3">
        <Button onClick={() => setVisible(!visible)}>Toggle side panel</Button>
        <Button onClick={() => setWorkspace(workspace === 'A' ? 'B' : 'A')}>
          Switch mock workspace
        </Button>
        <Button onClick={() => setVisit(visit + 1)}>Remount workspace</Button>
        <span>Mock workspace {workspace}</span>
      </div>
      <p className="p-3 text-sm text-muted-foreground">
        Resize the split, toggle the side panel, switch workspaces, or reload. The latest split is
        shared across these mock workspaces. This demo uses its own storage key.
      </p>
      <ResizablePanelGroup
        key={`${workspace}-${visit}`}
        direction="horizontal"
        autoSaveId="storybook-workspace-main-panel"
        className="flex-1"
      >
        <ResizablePanel id="workspace-chat" defaultSize="70%" minSize="30%">
          <div className="h-full bg-muted/30 p-6">Chat for mock workspace {workspace}</div>
        </ResizablePanel>
        {visible && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel id="workspace-side" defaultSize="30%" minSize="15%" maxSize="50%">
              <div className="h-full border-l p-6">Files for mock workspace {workspace}</div>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}

export const WorkspacePersistence: Story = {
  render: () => <WorkspaceSplitDemo />,
};
