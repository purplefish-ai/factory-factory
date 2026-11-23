// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RunScriptButton } from './run-script-button';
import { WorkspacePanelProvider } from './workspace-panel-context';

it('rereads the saved configuration when the setup panel opens, since no stream carries it', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  const paths: string[] = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            paths.push(op.path);
            observer.next({
              result: {
                data: {
                  status: 'IDLE',
                  pid: null,
                  port: null,
                  proxyUrl: null,
                  startedAt: null,
                  hasRunScript: false,
                  runScriptCommand: null,
                  runScriptPostRunCommand: null,
                  runScriptCleanupCommand: null,
                },
              },
            });
            observer.complete();
          }),
    ],
  });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(() =>
      root.render(
        <trpc.Provider client={api} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <TooltipProvider>
              <WorkspacePanelProvider workspaceId="ws-1">
                <RunScriptButton workspaceId="ws-1" />
              </WorkspacePanelProvider>
            </TooltipProvider>
          </QueryClientProvider>
        </trpc.Provider>
      )
    );
    await act(async () => {
      await vi.waitFor(() => expect(paths).toEqual(['workspace.getRunScriptStatus']));
    });

    const setup = element.querySelector<HTMLButtonElement>('button[aria-label="Setup dev server"]');
    await act(() => setup?.click());
    await act(async () => {
      await vi.waitFor(() =>
        expect(paths).toEqual(['workspace.getRunScriptStatus', 'workspace.getRunScriptStatus'])
      );
    });
  } finally {
    await act(() => root.unmount());
    queryClient.clear();
    element.remove();
    vi.unstubAllGlobals();
  }
});
