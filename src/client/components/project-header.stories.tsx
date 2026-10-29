import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { AppNavigationDataProvider } from '@/client/hooks/use-app-navigation-data';
import { ProjectHeaderNavigation, type ProjectNavigationProject } from './project-header';

function HeaderStory({
  project,
  workspaceName,
}: {
  project: ProjectNavigationProject;
  workspaceName?: string;
}) {
  return (
    <AppNavigationDataProvider
      value={{
        projects: undefined,
        projectsError: null,
        refetchProjects: fn(),
        selectedProjectSlug: project.slug,
        selectProjectSlug: fn(),
        selectedProjectId: project.id,
        issueProvider: 'GITHUB',
        serverWorkspaces: [],
        reviewCount: 0,
        agentsSummary: undefined,
        needsAttention: () => false,
        clearAttention: fn(),
        currentWorkspaceId: undefined,
      }}
    >
      <div className="flex items-center gap-1 border-b bg-background p-3 text-foreground">
        <ProjectHeaderNavigation project={project} showTrailingSlash={!!workspaceName} />
        {workspaceName ? <span className="truncate text-sm">{workspaceName}</span> : null}
      </div>
    </AppNavigationDataProvider>
  );
}
const meta = {
  title: 'Navigation/Project Header',
  component: HeaderStory,
  parameters: { layout: 'fullscreen' },
  args: { project: { id: 'factory', slug: 'factory-factory', name: 'Factory Factory' } },
} satisfies Meta<typeof HeaderStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Project: Story = {};
export const Workspace: Story = { args: { workspaceName: 'Review recent changes' } };
export const ArchivedOwner: Story = {
  args: { project: { id: 'archived', slug: 'archived-project', name: 'Archived project' } },
};
