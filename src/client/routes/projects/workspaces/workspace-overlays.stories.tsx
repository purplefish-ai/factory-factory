import type { Meta, StoryObj } from '@storybook/react';
import { ArchivingOverlay, InitializationOverlay } from './workspace-overlays';

const meta = {
  title: 'Workspaces/Overlays',
  component: ArchivingOverlay,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div className="relative h-screen w-screen bg-background">
        <div className="p-8 text-muted-foreground">
          <h1 className="text-2xl font-bold mb-4">Workspace Content Below</h1>
          <p>This represents the workspace content that would be behind the overlay.</p>
        </div>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArchivingOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Archiving: Story = {
  render: () => <ArchivingOverlay />,
};

export const InitializingWithoutScript: Story = {
  render: () => (
    <InitializationOverlay
      workspaceId="test-workspace"
      status="PROVISIONING"
      initErrorMessage={null}
      initOutput={null}
      hasStartupScript={false}
    />
  ),
};

export const InitializingWithScript: Story = {
  render: () => (
    <InitializationOverlay
      workspaceId="test-workspace"
      status="PROVISIONING"
      initErrorMessage={null}
      initOutput="Installing dependencies...\nnpm install\n✓ All dependencies installed"
      hasStartupScript={true}
    />
  ),
};

export const InitializationFailed: Story = {
  render: () => (
    <InitializationOverlay
      workspaceId="test-workspace"
      status="FAILED"
      initErrorMessage="Failed to run startup script: Command exited with code 1"
      initOutput="Installing dependencies...\nnpm install\nERROR: Package not found"
      hasStartupScript={true}
    />
  ),
};
