import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { WorkspaceToolsDrawer } from '@/client/components/workspace-tools-drawer';
import { RightPanel, useWorkspacePanel, WorkspacePanelProvider } from '@/client/features/workspace';
import { useWorkspaceDrawer } from '@/client/hooks/use-workspace-drawer';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';

const workspaceId = 'mobile-tools-fixture';

/** Frontend-only fixture shared by Storybook and the mobile browser regressions. */
export function WorkspaceToolsFixture() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              const responses: Record<string, unknown> = {
                'workspace.get': {
                  id: workspaceId,
                  projectId: 'demo',
                  periodicTaskId: null,
                  creationSource: 'MANUAL',
                },
                'workspace.getInitStatus': { status: 'READY', initOutput: '' },
                'workspace.getGitStatus': {
                  files: Array.from({ length: 35 }, (_, i) => ({
                    path: `src/component-${i}.tsx`,
                    status: 'M',
                    staged: false,
                  })),
                },
                'workspace.getDiffVsMain': {
                  added: [],
                  modified: [],
                  deleted: [],
                  noMergeBase: false,
                },
                'workspace.getUnpushedFiles': { files: [], hasUpstream: true },
                'workspace.listFiles': {
                  entries: [{ name: 'README.md', path: 'README.md', type: 'file' }],
                  hasWorktree: true,
                },
                'workspace.listScreenshots': { screenshots: [] },
                'workspace.listChildren': [],
                'project.list': [{ id: 'demo', name: 'Demo', slug: 'demo' }],
              };
              if (!(op.path in responses)) {
                const message = `Missing tools fixture: ${op.path}`;
                reportError(new Error(message));
                observer.error(new TRPCClientError(message));
                return;
              }
              observer.next({ result: { data: responses[op.path] } });
              observer.complete();
            }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <WorkspacePanelProvider workspaceId={workspaceId}>
          <ToolsSession />
        </WorkspacePanelProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

function ToolsSession() {
  const { rightPanelVisible, setRightPanelVisible } = useWorkspacePanel();
  const drawer = useWorkspaceDrawer();
  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <main className="flex min-w-0 flex-1 flex-col p-4">
        <div className="flex items-center justify-between gap-2">
          <h1 className="font-semibold">Session</h1>
          <Button onClick={() => setRightPanelVisible(true)}>Open tools</Button>
        </div>
        <p className="mt-8 text-sm text-muted-foreground">
          Reviewing the workspace changes. Your conversation stays here while you use the tools.
        </p>
        <label className="mt-auto">
          Message
          <textarea
            aria-label="Message"
            className="mt-2 w-full rounded-md border p-3"
            defaultValue="Keep this draft"
          />
        </label>
      </main>
      {drawer ? (
        <WorkspaceToolsDrawer open={rightPanelVisible} onOpenChange={setRightPanelVisible}>
          <RightPanel workspaceId={workspaceId} />
        </WorkspaceToolsDrawer>
      ) : (
        rightPanelVisible && (
          <div className="w-[40%] border-l">
            <RightPanel workspaceId={workspaceId} />
          </div>
        )
      )}
    </div>
  );
}
