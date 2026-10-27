import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useRef, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { FileBrowserPanel } from './file-browser-panel';
import { WorkspacePanelProvider } from './workspace-panel-context';

function FreshFileListings() {
  const changed = useRef(false);
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              const input = op.input as { path?: string };
              const filename = changed.current ? 'after.ts' : 'before.ts';
              observer.next({
                result: {
                  data: {
                    hasWorktree: true,
                    entries: input.path
                      ? [{ name: filename, type: 'file', path: `src/${filename}` }]
                      : [{ name: 'src', type: 'directory', path: 'src' }],
                  },
                },
              });
              observer.complete();
            }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <WorkspacePanelProvider workspaceId="file-refresh-story">
          <Button
            onClick={() => {
              changed.current = true;
            }}
          >
            Simulate file change
          </Button>
          <div className="h-72 w-80 border">
            <FileBrowserPanel workspaceId="file-refresh-story" />
          </div>
        </WorkspacePanelProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
const meta = { title: 'Workspace/FileBrowserPanel', component: FreshFileListings } satisfies Meta<
  typeof FreshFileListings
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RefreshFreshCache: Story = {
  beforeEach: () => {
    localStorage.setItem('file-tree-expanded-file-refresh-story', JSON.stringify(['src']));
    return () => localStorage.removeItem('file-tree-expanded-file-refresh-story');
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('before.ts');
    await userEvent.click(canvas.getByRole('button', { name: 'Simulate file change' }));
    await userEvent.click(canvas.getByTitle('Refresh file tree'));
    await expect(await canvas.findByText('after.ts')).toBeVisible();
  },
};
