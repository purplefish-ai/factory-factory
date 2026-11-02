import type { Meta, StoryObj } from '@storybook/react';
import { WorkspaceHeaderFixture } from './workspace-header-fixture';

const meta = {
  title: 'Navigation/Responsive App Header',
  component: WorkspaceHeaderFixture,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The installed desktop PWA uses Window Controls Overlay to share this header row with native window controls. The header reserves the browser-reported title-bar bounds on either side; empty space drags the window and interactive controls remain clickable. Browser tabs and unsupported installations retain the standard header.',
      },
    },
  },
} satisfies Meta<typeof WorkspaceHeaderFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Workspace: Story = {};
export const WorkspaceFamily: Story = { args: { variant: 'family' } };
export const TabletWorkspace: Story = {
  globals: { viewport: { value: 'tablet', isRotated: false } },
};
export const PhoneWorkspace: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
export const Project: Story = { args: { variant: 'project' } };
export const Generic: Story = { args: { variant: 'generic' } };

export const ProjectListError: Story = {
  args: { projectsError: true },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
