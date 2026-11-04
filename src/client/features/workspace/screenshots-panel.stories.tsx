import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { z } from 'zod';
import { trpc } from '@/client/lib/trpc';
import { Toaster } from '@/components/ui/sonner';
import { ScreenshotsPanel } from './screenshots-panel';
import { WorkspacePanelProvider } from './workspace-panel-context';

const workspaceId = 'screenshots-story';

const SCREENSHOTS = [
  { name: 'home.png', path: '.factory-factory/screenshots/home.png', size: 48_213, hue: 220 },
  {
    name: 'settings.png',
    path: '.factory-factory/screenshots/settings.png',
    size: 51_002,
    hue: 160,
  },
  { name: 'kanban.png', path: '.factory-factory/screenshots/kanban.png', size: 62_877, hue: 30 },
];

function placeholderImage(label: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="hsl(${hue} 45% 35%)"/><rect x="16" y="16" width="288" height="24" rx="4" fill="hsl(${hue} 45% 55%)"/><text x="160" y="110" font-family="sans-serif" font-size="22" fill="white" text-anchor="middle">${label}</text></svg>`;
  return btoa(svg);
}

type ListResponse = 'screenshots' | 'empty' | 'error';

interface ScreenshotsStoryProps {
  list: ListResponse;
  deleteFails?: boolean;
  isTakingScreenshots?: boolean;
}

function readScreenshot(input: unknown) {
  const { path } = z.object({ path: z.string() }).parse(input);
  const shot = SCREENSHOTS.find((candidate) => candidate.path === path);
  return {
    data: placeholderImage(shot?.name ?? path, shot?.hue ?? 0),
    mimeType: 'image/svg+xml',
    name: shot?.name ?? path,
  };
}

/** Resolves a mocked tRPC call to its data, or throws the mocked failure. */
function resolveOperation(
  path: string,
  input: unknown,
  { list, deleteFails = false }: ScreenshotsStoryProps
): unknown {
  switch (path) {
    case 'workspace.listScreenshots':
      if (list === 'error') {
        throw new TRPCClientError('Workspace worktree is missing; it may have been archived');
      }
      return {
        screenshots:
          list === 'screenshots'
            ? SCREENSHOTS.map(({ name, path: shotPath, size }) => ({ name, path: shotPath, size }))
            : [],
      };
    case 'workspace.readScreenshot':
      return readScreenshot(input);
    case 'workspace.deleteScreenshot':
      if (deleteFails) {
        throw new TRPCClientError('EACCES: permission denied, unlink home.png');
      }
      return { success: true };
    default:
      return null;
  }
}

function ScreenshotsStory(props: ScreenshotsStoryProps) {
  const { isTakingScreenshots = false } = props;
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              try {
                observer.next({ result: { data: resolveOperation(op.path, op.input, props) } });
                observer.complete();
              } catch (error) {
                observer.error(
                  error instanceof TRPCClientError
                    ? error
                    : new TRPCClientError('Story mock failed')
                );
              }
            }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <WorkspacePanelProvider workspaceId={workspaceId}>
          <div className="h-[420px] w-[360px] rounded-md border bg-background">
            <ScreenshotsPanel
              workspaceId={workspaceId}
              isTakingScreenshots={isTakingScreenshots}
              onTakeScreenshots={() => undefined}
            />
          </div>
        </WorkspacePanelProvider>
        <Toaster />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

async function openDeleteConfirmation(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const remove = await canvas.findByRole('button', { name: 'Delete screenshot home.png' });
  await userEvent.click(remove);
  return within(canvasElement.ownerDocument.body).findByRole('alertdialog');
}

const meta = {
  title: 'Workspace/ScreenshotsPanel',
  component: ScreenshotsStory,
  args: { list: 'screenshots' },
} satisfies Meta<typeof ScreenshotsStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Screenshots: Story = {};

export const Empty: Story = {
  args: { list: 'empty' },
};

/** A failed list query shows the error with Retry instead of "No screenshots yet". */
export const LoadError: Story = {
  args: { list: 'error' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent("Couldn't load screenshots");
    await expect(canvas.queryByText('No screenshots yet')).toBeNull();
  },
};

/** The hover X asks before unlinking the file. */
export const DeleteConfirmation: Story = {
  play: async ({ canvasElement }) => {
    const dialog = await openDeleteConfirmation(canvasElement);
    await expect(dialog).toHaveTextContent('Delete screenshot?');
    await expect(dialog).toHaveTextContent('"home.png" will be permanently deleted');
  },
};

/** A failed delete keeps the dialog open and explains the failure in a toast. */
export const DeleteFailed: Story = {
  args: { deleteFails: true },
  play: async ({ canvasElement }) => {
    const dialog = await openDeleteConfirmation(canvasElement);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    const body = within(canvasElement.ownerDocument.body);
    const title = await body.findByText("Couldn't delete screenshot");
    await waitFor(() => expect(title).toBeVisible());
    await waitFor(() => expect(body.getByRole('alertdialog')).toBeVisible());
  },
};
