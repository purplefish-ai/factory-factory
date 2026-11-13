import type { Meta } from '@storybook/react';
import { AppHeader } from '@/client/components/app-header';
import {
  AppHeaderProvider,
  HeaderLeftStartSlot,
  HeaderRightSlot,
} from '@/client/components/app-header-context';
import type { StoryTrpcHandlers } from '@/client/lib/storybook-trpc';
import { SidebarProvider } from '@/components/ui/sidebar';
import { IssueProvider } from '@/shared/core/enums';
import { KanbanBoard } from './kanban-board';
import type { WorkspaceWithKanban } from './kanban-card';
import { baseWorkspace } from './kanban-card.story-fixtures';
import { KanbanProvider } from './kanban-context';
import { KanbanControls } from './kanban-controls';

export const workspaces: WorkspaceWithKanban[] = [
  { ...baseWorkspace, id: 'ws-1', kanbanColumn: 'WORKING', name: 'Add authentication' },
  { ...baseWorkspace, id: 'ws-2', kanbanColumn: 'WORKING', name: 'Fix login bug' },
  {
    ...baseWorkspace,
    id: 'ws-3',
    kanbanColumn: 'WAITING',
    name: 'Update dependencies',
    waitingSince: '2026-11-04T12:00:00.000Z',
    prNumber: 42,
    prUrl: '#',
    prState: 'OPEN',
  },
  {
    ...baseWorkspace,
    id: 'ws-4',
    kanbanColumn: 'DONE',
    name: 'Fix typo',
    prNumber: 40,
    prUrl: '#',
    prState: 'MERGED',
  },
];

export const handlers: StoryTrpcHandlers = {
  'workspace.listForProject': () => ({ workspaces, reviewCount: 0 }),
  'github.listIssuesForProject': () => ({
    issues: [
      {
        number: 7,
        title: 'Support keyboard shortcuts on the board',
        body: '',
        url: 'https://github.com/purplefish-ai/factory-factory/issues/7',
        state: 'OPEN',
        createdAt: '2026-10-01T12:00:00Z',
        author: { login: 'martin' },
      },
    ],
  }),
};

function BoardActions() {
  return (
    <HeaderRightSlot>
      <KanbanControls />
    </HeaderRightSlot>
  );
}

/**
 * The real KanbanBoard and KanbanProvider, fed by story tRPC handlers rather
 * than a backend. `Board/KanbanBoard` lays out columns directly; these stories
 * cover the responsive board, including the phone column tabs.
 */
export const kanbanBoardMeta = {
  component: KanbanBoard,
  parameters: { layout: 'fullscreen', trpc: { handlers } },
  decorators: [
    // Each story gets its own project, so module state keyed by project (the
    // new-workspace draft store, for one) starts cold whatever ran before it.
    (Story, { id }) => (
      <SidebarProvider>
        <div className="flex h-dvh w-full min-w-0 flex-col overflow-hidden md:h-auto md:overflow-visible">
          <AppHeaderProvider>
            <KanbanProvider
              projectId={`proj-${id}`}
              projectSlug="demo"
              issueProvider={IssueProvider.GITHUB}
            >
              <AppHeader />
              <HeaderLeftStartSlot>
                <nav
                  aria-label="Breadcrumb"
                  className="flex min-w-0 items-center gap-1 text-sm font-semibold"
                >
                  <span className="truncate">Factory Factory</span>
                  <span aria-hidden className="text-muted-foreground">
                    /
                  </span>
                  <span>Board</span>
                </nav>
              </HeaderLeftStartSlot>
              <BoardActions />
              <div className="h-[calc(100dvh-81px)] min-h-0 p-3 md:h-[640px] md:p-4">
                <Story />
              </div>
            </KanbanProvider>
          </AppHeaderProvider>
        </div>
      </SidebarProvider>
    ),
  ],
} satisfies Meta<typeof KanbanBoard>;
