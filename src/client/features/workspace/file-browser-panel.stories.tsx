import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useRef, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { removeStorageItem, writeStorageItem } from '@/client/lib/browser-storage';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { FileBrowserPanel } from './file-browser-panel';
import { WorkspacePanelProvider } from './workspace-panel-context';

function storyFiles(endpoint: string, input: { path?: string; query?: string }, filename: string) {
  if (endpoint === 'workspace.listAllFiles') {
    return { files: input.query === 'bfr' ? ['src/before.ts', 'tests/before.ts'] : [] };
  }
  return {
    entries: input.path
      ? [{ name: filename, type: 'file', path: `src/${filename}` }]
      : [{ name: 'src', type: 'directory', path: 'src' }],
  };
}

function FreshFileListings() {
  const changed = useRef(false);
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              const input = op.input as { path?: string; query?: string };
              const filename = changed.current ? 'after.ts' : 'before.ts';
              observer.next({
                result: { data: { hasWorktree: true, ...storyFiles(op.path, input, filename) } },
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
    writeStorageItem('file-tree-expanded-file-refresh-story', JSON.stringify(['src']));
    return () => removeStorageItem('file-tree-expanded-file-refresh-story');
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('before.ts');
    await userEvent.click(canvas.getByRole('button', { name: 'Simulate file change' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Refresh file tree' }));
    await expect(await canvas.findByText('after.ts')).toBeVisible();
  },
};

export const MatchingFiles: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'src' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    await userEvent.type(canvas.getByRole('textbox', { name: 'Search files' }), 'bfr');
    const results = within(await canvas.findByRole('list', { name: 'File search results' }));
    await expect(results.getByRole('button', { name: 'before.ts src' })).toBeVisible();
    await expect(results.getByRole('button', { name: 'before.ts tests' })).toBeVisible();
  },
};

export const NoMatchingFiles: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Search files' }), 'missing');
    await expect(await canvas.findByText('No matching files')).toBeVisible();
  },
};
