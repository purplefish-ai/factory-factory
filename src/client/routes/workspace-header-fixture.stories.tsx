import type { Meta, StoryObj } from '@storybook/react';
import { WorkspaceHeaderFixture } from './workspace-header-fixture';

const meta = {
  title: 'Navigation/Responsive App Header',
  component: WorkspaceHeaderFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof WorkspaceHeaderFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Workspace: Story = {};
export const TabletWorkspace: Story = {
  globals: { viewport: { value: 'tablet', isRotated: false } },
};
export const PhoneWorkspace: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
export const Project: Story = { args: { variant: 'project' } };
export const Generic: Story = { args: { variant: 'generic' } };
