import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { MessageItem } from '@/client/features/chat/agent-activity/agent-activity';
import { CopyMessageButton } from '@/client/features/chat/agent-activity/copy-message-button';
import { QueuedMessages } from '@/client/features/chat/queued-messages';
import { KanbanCard } from '@/client/features/kanban/kanban-card';
import { baseWorkspace } from '@/client/features/kanban/kanban-card.story-fixtures';
import { ScreenshotsPanel } from '@/client/features/workspace/screenshots-panel';
import { TerminalTabBar } from '@/client/features/workspace/terminal-tab-bar';
import { WorkspacePanelProvider } from '@/client/features/workspace/workspace-panel-context';
import { trpc } from '@/client/lib/trpc';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SidebarMenuAction } from '@/components/ui/sidebar';
import { TabButton } from '@/components/ui/tab-button';
import { TooltipProvider } from '@/components/ui/tooltip';

/** Frontend-only regression surface for actions that used to require hover. */
export function HoverActionsFixture() {
  const [removed, setRemoved] = useState(false);
  const [closed, setClosed] = useState(false);
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              const data =
                op.path === 'workspace.listScreenshots'
                  ? { screenshots: [{ name: 'Home', path: 'home.png', size: 1 }] }
                  : op.path === 'workspace.readScreenshot'
                    ? {
                        mimeType: 'image/gif',
                        data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
                      }
                    : [];
              observer.next({ result: { data } });
              observer.complete();
            }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <div className="mx-auto max-w-lg space-y-6 p-4">
            <KanbanCard
              workspace={baseWorkspace}
              projectSlug="demo"
              onArchive={() => undefined}
              onOpenQuickChat={() => undefined}
              onRename={async () => undefined}
            />
            <div className="group relative min-h-16 border p-4">
              Assistant response
              <CopyMessageButton textContent="Assistant response" />
            </div>
            <MessageItem
              message={{
                id: 'user',
                source: 'user',
                text: 'User prompt',
                timestamp: '2026-01-01',
                order: 0,
              }}
              userMessageUuid="user"
              onRewindToMessage={() => undefined}
            />
            <WorkspacePanelProvider workspaceId="hover-fixture">
              <div className="h-28">
                <ScreenshotsPanel workspaceId="hover-fixture" isTakingScreenshots={false} />
              </div>
            </WorkspacePanelProvider>
            <TabButton
              icon={null}
              label="File"
              isActive={false}
              onSelect={() => undefined}
              onClose={() => undefined}
            />
            <QueuedMessages
              messages={
                removed
                  ? []
                  : [
                      {
                        id: 'queued',
                        text: 'Pending prompt',
                        timestamp: '2026-01-01',
                        settings: {
                          selectedModel: null,
                          reasoningEffort: null,
                          thinkingEnabled: false,
                          planModeEnabled: false,
                        },
                      },
                    ]
              }
              onRemove={() => setRemoved(true)}
            />
            <div className="group/menu-item relative h-10">
              Sidebar item
              <SidebarMenuAction showOnHover aria-label="Sidebar action">
                +
              </SidebarMenuAction>
            </div>
            <ScrollArea type="always" className="h-16 border" data-testid="hover-scroll">
              <div className="h-48">Scrollable content</div>
            </ScrollArea>
            <TerminalTabBar
              tabs={
                closed
                  ? [{ id: 'active', label: 'Active' }]
                  : [
                      { id: 'active', label: 'Active' },
                      { id: 'inactive', label: 'Inactive' },
                    ]
              }
              activeTabId="active"
              onSelectTab={() => undefined}
              onCloseTab={() => setClosed(true)}
            />
          </div>
        </TooltipProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
