import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@/components/ui/button';
import { ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { WorkspaceSidePanel } from './workspace-side-panel';

function WorkspaceSidePanelDemo() {
  const [visible, setVisible] = useState(true);
  return (
    <div className="flex h-screen flex-col">
      <div className="border-b p-2">
        <Button size="sm" variant="outline" onClick={() => setVisible((value) => !value)}>
          Toggle tools panel
        </Button>
      </div>
      <ResizablePanelGroup direction="horizontal" className="flex-1">
        <ResizablePanel id="workspace-chat" defaultSize="70%" minSize="30%">
          <div className="p-4 text-sm text-muted-foreground">Chat</div>
        </ResizablePanel>
        <WorkspaceSidePanel visible={visible}>
          <div className="p-4 text-sm">Workspace tools: files, changes and terminal</div>
        </WorkspaceSidePanel>
      </ResizablePanelGroup>
    </div>
  );
}

const meta = {
  title: 'Workspace/SidePanel',
  component: WorkspaceSidePanelDemo,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof WorkspaceSidePanelDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Toggle: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole('button', { name: 'Toggle tools panel' });
    await expect(canvas.getByText(/Workspace tools/)).toBeVisible();
    await userEvent.click(toggle);
    await waitFor(() => expect(canvas.queryByText(/Workspace tools/)).toBeNull());
    await userEvent.click(toggle);
    await expect(await canvas.findByText(/Workspace tools/)).toBeVisible();
  },
};
