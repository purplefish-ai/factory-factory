import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { useRef, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { RightPanel } from './right-panel';
import { WorkspacePanelProvider } from './workspace-panel-context';

const workspaceId = 'right-panel-capabilities-story';
function RightPanelStory({ hasTask = false }: { hasTask?: boolean }) {
  const taskPresent = useRef(hasTask);
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              const responses: Record<string, () => unknown> = {
                'workspace.get': () => ({
                  id: workspaceId,
                  projectId: 'right-panel-project',
                  mode: 'STANDARD',
                  periodicTaskId: taskPresent.current ? 'task-1' : null,
                  creationSource: 'MANUAL',
                }),
                'workspace.getInitStatus': () => ({ status: 'READY', initOutput: '' }),
                'workspace.getGitStatus': () => ({ files: [] }),
                'workspace.getDiffVsMain': () => ({
                  added: [],
                  modified: [],
                  deleted: [],
                  noMergeBase: false,
                }),
                'workspace.getUnpushedFiles': () => ({ files: [], hasUpstream: true }),
                'periodicTask.get': () => ({
                  name: 'Scheduled cleanup',
                  prompt: 'Clean up completed work',
                  cadence: 'DAILY',
                  isEnabled: false,
                  lastRunAt: null,
                }),
                'periodicTask.listExecutions': () => [],
              };
              const respond = responses[op.path];
              if (!respond) {
                observer.error(new TRPCClientError(`Missing story fixture: ${op.path}`));
                return;
              }
              observer.next({ result: { data: respond() } });
              observer.complete();
            }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <WorkspacePanelProvider workspaceId={workspaceId}>
          <Button
            onClick={() => {
              taskPresent.current = false;
              runInBackground(
                queryClient.invalidateQueries({
                  queryKey: getQueryKey(trpc.workspace.get, { id: workspaceId }, 'query'),
                }),
                'Could not refresh workspace'
              );
            }}
          >
            Delete periodic task
          </Button>
          <div className="h-[650px] w-[800px] border">
            <RightPanel workspaceId={workspaceId} />
          </div>
        </WorkspacePanelProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

// Keep terminal/log channels disconnected in this local fixture.
class StorySocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  close() {
    this.readyState = 3;
  }
  send() {
    /* Offline story channels do not transmit messages. */
  }
}
const meta = {
  title: 'Workspace/RightPanel',
  component: RightPanelStory,
  parameters: { layout: 'padded' },
  beforeEach: () => {
    const socket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: StorySocket,
    });
    const entries = [
      [`workspace-right-panel-tab-${workspaceId}`, 'periodic-task'],
      [`workspace-panel-bottom-tab-${workspaceId}`, 'setup-logs'],
    ];
    const previous = entries.map(([key]) => [key, localStorage.getItem(key ?? '')]);
    for (const [key, value] of entries) {
      if (key && value) {
        localStorage.setItem(key, value);
      }
    }
    return () => {
      if (socket) {
        Object.defineProperty(globalThis, 'WebSocket', socket);
      }
      for (const [key, value] of previous) {
        if (!key) {
          continue;
        }
        if (value == null) {
          localStorage.removeItem(key);
        } else {
          localStorage.setItem(key, value);
        }
      }
    };
  },
} satisfies Meta<typeof RightPanelStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DeletedTaskPreference: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No changes')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Periodic Task' })).not.toBeInTheDocument();
    await expect(localStorage.getItem(`workspace-right-panel-tab-${workspaceId}`)).toBe('changes');
  },
};
export const DeleteWhileOpen: Story = {
  args: { hasTask: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Scheduled cleanup');
    await userEvent.click(canvas.getByRole('button', { name: 'Delete periodic task' }));
    await expect(await canvas.findByText('No changes')).toBeVisible();
    await expect(localStorage.getItem(`workspace-right-panel-tab-${workspaceId}`)).toBe('changes');
  },
};
