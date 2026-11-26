import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, within } from 'storybook/test';
import { AppHeader } from '@/client/components/app-header';
import { AppHeaderProvider } from '@/client/components/app-header-context';
import { handlers } from '@/client/features/kanban/kanban-board.provider.story-fixtures';
import { AppNavigationDataProvider } from '@/client/hooks/use-app-navigation-data';
import { SidebarProvider } from '@/components/ui/sidebar';
import { WorkspacesBoardView } from './workspaces-board-view';

const meta = {
  title: 'Board/WorkspacesBoardPage',
  component: WorkspacesBoardView,
  args: {
    projectId: 'demo',
    slug: 'demo',
    projectName: 'Demo',
    issueProvider: 'GITHUB',
    projects: [],
  },
  parameters: { layout: 'fullscreen', trpc: { handlers } },
  decorators: [
    (Story) => (
      <AppNavigationDataProvider
        value={{
          projects: undefined,
          projectsError: null,
          refetchProjects: fn(),
          selectedProjectSlug: 'demo',
          selectProjectSlug: () => undefined,
          selectedProjectId: 'demo',
          issueProvider: 'GITHUB',
          serverWorkspaces: undefined,
          reviewCount: 0,
          agentsSummary: undefined,
          needsAttention: () => false,
          clearAttention: () => undefined,
          currentWorkspaceId: undefined,
        }}
      >
        <SidebarProvider>
          <AppHeaderProvider>
            <div className="flex h-dvh min-w-0 flex-1 flex-col">
              <AppHeader />
              <main className="min-h-0 flex-1">
                <Story />
              </main>
            </div>
          </AppHeaderProvider>
        </SidebarProvider>
      </AppNavigationDataProvider>
    ),
  ],
} satisfies Meta<typeof WorkspacesBoardView>;
export default meta;

export const Phone: StoryObj<typeof meta> = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const header = canvas.getByRole('banner');
    const tabs = await canvas.findByRole('navigation', { name: 'Board sections' });
    await expect(tabs.getBoundingClientRect().top).toBeCloseTo(
      header.getBoundingClientRect().bottom
    );
    const todo = within(tabs).getByRole('link', { name: /^Todo/ });
    await expect(todo.getBoundingClientRect().height).toBeGreaterThanOrEqual(40);
  },
};
