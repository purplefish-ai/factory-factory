import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { z } from 'zod';
import { trpc } from '@/client/lib/trpc';
import { type ChangeListEntry, ChangeTreeView } from './change-panel-shared';
import { FileTree } from './file-tree';
import { FileTreeProvider } from './file-tree-context';

const workspaceId = 'file-tree-density';
const entries: ChangeListEntry[] = [
  { path: 'docs/plans/a-long-file-name-that-should-truncate.md', kind: 'added', statusCode: 'A' },
  { path: 'docs/plans/review.md', kind: 'modified', statusCode: 'M', showIndicatorDot: true },
  { path: 'drafts/', kind: 'untracked', statusCode: '?' },
  { path: 'src/app.tsx', kind: 'modified', statusCode: 'M' },
  { path: 'README.md', kind: 'deleted', statusCode: 'D' },
];
const filePaths = [
  ...entries.filter((entry) => !entry.path.endsWith('/')).map((entry) => entry.path),
  'drafts/nested/notes.md',
];

function listFiles(path: string) {
  const prefix = path ? `${path}/` : '';
  const children = new Map<string, { name: string; path: string; type: string }>();
  for (const filePath of filePaths.filter((value) => value.startsWith(prefix))) {
    const remainder = filePath.slice(prefix.length);
    const name = remainder.split('/')[0] ?? remainder;
    children.set(name, {
      name,
      path: `${prefix}${name}`,
      type: remainder.includes('/') ? 'directory' : 'file',
    });
  }
  return [...children.values()].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

function MatchingTrees({
  virtualized = false,
  directoryState = 'loaded',
}: {
  virtualized?: boolean;
  directoryState?: 'loaded' | 'loading' | 'error';
}) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              const { path = '' } = z.object({ path: z.string().optional() }).parse(op.input);
              if (path === 'drafts' && directoryState !== 'loaded') {
                if (directoryState === 'error') {
                  observer.error(new TRPCClientError('Directory unavailable'));
                }
                return;
              }
              observer.next({ result: { data: { entries: listFiles(path), hasWorktree: true } } });
              observer.complete();
            }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="flex gap-4">
          <section>
            <h2 className="mb-2 text-sm">Files</h2>
            <div className="h-96 w-80 overflow-auto border p-1" data-testid="files">
              <FileTreeProvider workspaceId={workspaceId}>
                <FileTree workspaceId={workspaceId} onFileSelect={fn()} />
              </FileTreeProvider>
            </div>
          </section>
          <section>
            <h2 className="mb-2 text-sm">Changes</h2>
            <div className="h-96 w-80 overflow-auto border p-1" data-testid="changes">
              <ChangeTreeView
                entries={entries}
                onFileClick={fn()}
                workspaceId={workspaceId}
                virtualized={virtualized}
              />
            </div>
          </section>
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: 'Workspace/FileTrees',
  component: MatchingTrees,
  beforeEach: () => {
    localStorage.setItem(
      `file-tree-expanded-${workspaceId}`,
      JSON.stringify(['docs', 'docs/plans', 'src', 'drafts', 'drafts/nested'])
    );
    return () => localStorage.removeItem(`file-tree-expanded-${workspaceId}`);
  },
} satisfies Meta<typeof MatchingTrees>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CompactRows: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const files = within(canvas.getByTestId('files'));
    const changes = within(canvas.getByTestId('changes'));
    await files.findByText('notes.md');
    await changes.findByText('notes.md');
    const fileRows = files.getAllByRole('button');
    const changeRows = changes.getAllByRole('button');
    await expect(changeRows).toHaveLength(fileRows.length);
    // Expanded untracked directories settle after the virtualizer's ResizeObserver runs.
    await waitFor(async () => {
      for (const [index, row] of changeRows.entries()) {
        const fileRow = fileRows[index];
        if (!fileRow) {
          throw new Error(`Missing Files row ${index}`);
        }
        await expect(row.getBoundingClientRect().height).toBe(28);
        await expect(row.getBoundingClientRect().top).toBe(fileRow.getBoundingClientRect().top);
        await expect(row.style.paddingLeft).toBe(fileRow.style.paddingLeft);
        await expect(getComputedStyle(row).fontWeight).toBe(getComputedStyle(fileRow).fontWeight);
      }
    });
    await userEvent.click(changes.getByRole('button', { name: 'plans' }));
    await expect(changes.queryByText('review.md')).not.toBeInTheDocument();
  },
};

export const VirtualizedRows: Story = {
  ...CompactRows,
  args: { virtualized: true },
};

async function checkPlaceholder(canvasElement: HTMLElement, text: string) {
  const changes = within(within(canvasElement).getByTestId('changes'));
  const placeholder = await changes.findByText(text);
  const folder = changes.getByRole('button', { name: 'drafts ?' });
  await expect(placeholder.parentElement?.getBoundingClientRect().height).toBe(
    folder.getBoundingClientRect().height
  );
}

export const LoadingDirectory: Story = {
  args: { directoryState: 'loading' },
  play: async ({ canvasElement }) => checkPlaceholder(canvasElement, 'Loading…'),
};

export const DirectoryError: Story = {
  args: { directoryState: 'error' },
  play: async ({ canvasElement }) =>
    checkPlaceholder(canvasElement, 'Failed to load directory contents'),
};
