import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { AppHeaderProvider } from '@/client/components/app-header-context';
import { AppNavigationDataProvider } from '@/client/hooks/use-app-navigation-data';
import NewProjectPage from './new';

const meta = {
  title: 'Projects/NewProjectPage',
  component: NewProjectPage,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story, context) => (
      <AppHeaderProvider>
        <AppNavigationDataProvider
          value={{
            projects: undefined,
            projectsError: context.parameters.projectsError ?? null,
            refetchProjects: fn(),
            selectedProjectSlug: '',
            selectProjectSlug: () => undefined,
            selectedProjectId: undefined,
            issueProvider: 'GITHUB',
            serverWorkspaces: undefined,
            reviewCount: 0,
            needsAttention: () => false,
            clearAttention: () => undefined,
            currentWorkspaceId: undefined,
          }}
        >
          <Story />
        </AppNavigationDataProvider>
      </AppHeaderProvider>
    ),
  ],
} satisfies Meta<typeof NewProjectPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LoadingProjects: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'A single loading status is announced; the decorative spinner is hidden from assistive technology.',
      },
    },
  },
};

export const ProjectsError: Story = {
  parameters: {
    projectsError: { message: 'Could not connect to the backend. Please try again.' },
    docs: {
      description: {
        story: 'A failed project list shows an error, retry, and a way back to Projects.',
      },
    },
  },
};
