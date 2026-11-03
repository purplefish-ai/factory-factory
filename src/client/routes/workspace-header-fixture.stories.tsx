import type { Meta, StoryObj } from '@storybook/react';
import { WorkspaceHeaderFixture } from './workspace-header-fixture';
import { WorkspaceHeaderPwaPreview } from './workspace-header-pwa-preview';

const meta = {
  title: 'Navigation/Responsive App Header',
  component: WorkspaceHeaderFixture,
  parameters: {
    layout: 'fullscreen',
    docs: {
      // Native-geometry CSS and rem-based font previews need their own document
      // when the docs page shows several header stories at once.
      story: { inline: false, iframeHeight: 120 },
      description: {
        component:
          'The installed desktop PWA uses compact controls centered in the browser-reported title-bar area. A subtle theme-relative surface has tight S-curves on either side, leaving room for native controls. Larger fonts can grow the row without clipping. Empty space drags the window; interactive controls remain clickable. PWA stories simulate native geometry using the production CSS. Browser tabs and unsupported installations retain the standard header.',
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

export const InstalledPwaControlsLeft: Story = {
  globals: { theme: 'dark' },
  decorators: [
    (Story) => (
      <WorkspaceHeaderPwaPreview side="left">
        <Story />
      </WorkspaceHeaderPwaPreview>
    ),
  ],
};
export const InstalledPwaControlsRight: Story = {
  globals: { theme: 'dark' },
  decorators: [
    (Story) => (
      <WorkspaceHeaderPwaPreview side="right">
        <Story />
      </WorkspaceHeaderPwaPreview>
    ),
  ],
};
export const InstalledPwaLight: Story = {
  globals: { theme: 'light' },
  decorators: InstalledPwaControlsLeft.decorators,
};
export const InstalledPwaLargeText: Story = {
  args: { variant: 'family' },
  globals: { theme: 'dark' },
  decorators: [
    (Story) => (
      <WorkspaceHeaderPwaPreview side="right" fontScale={150}>
        <Story />
      </WorkspaceHeaderPwaPreview>
    ),
  ],
};

export const ProjectListError: Story = {
  args: { projectsError: true },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
