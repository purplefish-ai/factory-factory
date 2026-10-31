import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import type { ChatProvider } from '@/shared/chat-capabilities';
import { InlineWorkspaceForm } from './inline-workspace-form';
import {
  createWorkspaceCreationDraft,
  saveWorkspaceCreationDraft,
} from './workspace-creation-draft-storage';

const onCreate = fn();
const onCancel = fn();

function previewLaunchOptions(input: unknown) {
  const record = typeof input === 'object' && input !== null ? input : {};
  const provider = 'provider' in record && record.provider === 'CLAUDE' ? 'CLAUDE' : 'CODEX';
  const model = 'model' in record && typeof record.model === 'string' ? record.model : 'default';
  const values =
    provider === 'CLAUDE'
      ? ['default', 'low', 'medium', 'high', 'xhigh', 'max']
      : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  return {
    provider,
    model,
    reasoning: {
      options: values.map((value) => ({
        value,
        label: value === 'xhigh' ? 'Extra high' : value.slice(0, 1).toUpperCase() + value.slice(1),
      })),
      selected: provider === 'CLAUDE' ? 'default' : 'high',
      defaultValue: provider === 'CLAUDE' ? 'default' : 'low',
    },
    planMode: { supported: true, selected: false },
    accessMode: {
      options:
        provider === 'CODEX'
          ? [
              { value: 'read-only', label: 'Read only' },
              { value: 'workspace-write', label: 'Workspace write' },
              { value: 'agent-full-access', label: 'Full access' },
            ]
          : [
              { value: 'default', label: 'Default' },
              { value: 'acceptEdits', label: 'Accept edits' },
            ],
      selected: provider === 'CODEX' ? 'read-only' : 'default',
    },
  };
}

function previewResponse(path: string, input: unknown, provider: ChatProvider) {
  if (path === 'session.getLaunchOptions') {
    return previewLaunchOptions(input);
  }
  const responses: Record<string, unknown> = {
    'codexAccounts.list': [
      { id: 'personal', label: 'Personal', authenticated: true, enabled: true },
      { id: 'work', label: 'Work', authenticated: true, enabled: true },
    ],
    'userSettings.get': {
      defaultSessionProvider: provider,
      defaultClaudeModel: 'sonnet',
      defaultCodexModel: 'six-sol',
      ratchetEnabled: false,
      defaultClaudeReasoningEffort: null,
      defaultCodexReasoningEffort: 'high',
    },
    'userSettings.getProviderOptions': {
      CLAUDE: {
        models: [
          { value: 'sonnet', label: 'Sonnet' },
          { value: 'opus', label: 'Opus' },
        ],
      },
      CODEX: {
        models: [
          { value: 'six-sol', label: 'GPT-6.1-Sol' },
          { value: 'six-luna', label: '6 Luna' },
        ],
      },
    },
    'project.listSlashCommands': { commands: [] },
    'project.listAllFiles': { files: [] },
    'workspace.listForProject': { workspaces: [], reviewCount: 0 },
    'workspace.create': {
      id: 'preview-workspace',
      projectId: 'preview-project',
      name: 'Preview workspace',
      status: 'NEW',
      createdAt: new Date(),
      ratchetEnabled: false,
    },
  };
  return responses[path] ?? {};
}
function previewShouldWait(path: string, loading: boolean, catalogLoading: boolean) {
  return (
    (path === 'userSettings.get' && loading) ||
    (path === 'userSettings.getProviderOptions' && catalogLoading)
  );
}

/** All requests stay inside this preview transport, including launch button clicks. */
function WorkspaceCreationPreviewSession({
  provider = 'CODEX',
  loading = false,
  catalogLoading = false,
  compact = false,
  startCollapsed = false,
  projectId = 'preview-project',
}: {
  provider?: ChatProvider;
  loading?: boolean;
  catalogLoading?: boolean;
  compact?: boolean;
  startCollapsed?: boolean;
  projectId?: string;
}) {
  const [open, setOpen] = useState(!startCollapsed);
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              if (previewShouldWait(op.path, loading, catalogLoading)) {
                return;
              }
              if (op.type === 'mutation') {
                onCreate(op.input);
              }
              observer.next({ result: { data: previewResponse(op.path, op.input, provider) } });
              observer.complete();
            }),
      ],
    })
  );
  return (
    <QueryClientProvider client={queryClient}>
      <trpc.Provider client={client} queryClient={queryClient}>
        <div
          className="max-w-full"
          style={{
            width: compact ? 'min(20rem, calc(100vw - 2rem))' : 'min(40rem, calc(100vw - 2rem))',
          }}
        >
          {open ? (
            <InlineWorkspaceForm
              projectId={projectId}
              existingNames={[]}
              onCreated={fn()}
              onCancel={() => {
                onCancel();
                if (startCollapsed) {
                  setOpen(false);
                }
              }}
            />
          ) : (
            <Button variant="outline" onClick={() => setOpen(true)}>
              New Workspace
            </Button>
          )}
        </div>
      </trpc.Provider>
    </QueryClientProvider>
  );
}

function WorkspaceCreationPreview(props: {
  provider?: ChatProvider;
  loading?: boolean;
  catalogLoading?: boolean;
  compact?: boolean;
  startCollapsed?: boolean;
  projectId?: string;
}) {
  const key = `${props.projectId ?? 'preview-project'}:${props.provider ?? 'CODEX'}:${Boolean(props.loading)}:${Boolean(props.catalogLoading)}:${Boolean(props.startCollapsed)}`;
  return <WorkspaceCreationPreviewSession key={key} {...props} />;
}

const meta = {
  title: 'Kanban/InlineWorkspaceForm',
  component: WorkspaceCreationPreview,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof WorkspaceCreationPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SavedCodexDefaults: Story = {};
export const OpenFromButton: Story = { args: { startCollapsed: true } };
export const SavedClaudeDefaults: Story = { args: { provider: 'CLAUDE' } };
export const Dark: Story = { globals: { theme: 'dark' } };
export const Loading: Story = { args: { loading: true } };
export const CatalogLoading: Story = { args: { catalogLoading: true } };
export const Narrow: Story = {
  args: { compact: true },
  parameters: { viewport: { value: 'mobile1' } },
};
export const NarrowDark: Story = { ...Narrow, globals: { theme: 'dark' } };
export const Sidebar: Story = {
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
  globals: { theme: 'dark' },
};
export const SidebarClaude: Story = { ...Sidebar, args: { provider: 'CLAUDE' } };
export const SidebarSettings: Story = {
  ...Sidebar,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: 'Thinking level: High' });
    await userEvent.click(canvas.getByRole('button', { name: 'Workspace settings' }));
    const settings = within(canvasElement.ownerDocument.body).getByRole('dialog', {
      name: 'Workspace settings',
    });
    await waitFor(() =>
      expect(within(settings).getByRole('button', { name: 'Codex account: Auto' })).toBeVisible()
    );
    await userEvent.click(within(settings).getByRole('button', { name: 'Planning: Off' }));
    await expect(within(settings).getByRole('button', { name: 'Planning: On' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  },
};

async function selectSidebarLaunchMode(canvasElement: HTMLElement, mode: string) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: 'Choose launch mode' }));
  await userEvent.click(
    within(canvasElement.ownerDocument.body).getByRole('menuitem', { name: mode })
  );
  const cancel = (await canvas.findByRole('button', { name: 'Cancel' })).getBoundingClientRect();
  const menu = canvas.getByRole('button', { name: 'Choose launch mode' }).getBoundingClientRect();
  const card = canvasElement.querySelector('[data-slot="card"]')?.getBoundingClientRect();
  await expect(card).toBeDefined();
  await expect(menu.top).toBe(cancel.top);
  await expect(menu.right).toBeLessThanOrEqual(card?.right ?? 0);
}

export const SidebarPeriodicTask: Story = {
  ...Sidebar,
  play: ({ canvasElement }) => selectSidebarLaunchMode(canvasElement, 'Create Agent'),
};

export const RestoredDraft: Story = {
  args: { projectId: 'preview-restored-draft' },
  loaders: [
    async () => {
      await saveWorkspaceCreationDraft('preview-restored-draft', {
        ...createWorkspaceCreationDraft(),
        prompt:
          'Investigate the failing workspace setup and preserve these notes.\nResume this task after checking the board.',
        attachments: [
          {
            id: 'notes',
            name: 'setup-notes.txt',
            type: 'text/plain',
            size: 19,
            data: 'Keep the worktree.',
            contentType: 'text',
          },
        ],
        launchSelection: {
          provider: 'CODEX',
          defaults: { defaultSessionProvider: 'CODEX', defaultCodexModel: 'six-sol' },
          drafts: { CODEX: { reasoningEffort: null, planModeEnabled: true } },
        },
      });
      return {};
    },
  ],
};

export const UnrestorableDraft: Story = {
  args: { projectId: 'preview-corrupt-draft' },
  loaders: [
    async () => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('factory-factory-workspace-drafts', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('drafts');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('drafts', 'readwrite');
          transaction
            .objectStore('drafts')
            .put({ schemaVersion: 999, attachments: 'incompatible' }, 'preview-corrupt-draft');
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => {
            database.close();
            reject(transaction.error);
          };
        };
      });
      return {};
    },
  ],
};

export const RestoredDraftNarrow: Story = {
  ...RestoredDraft,
  args: { ...RestoredDraft.args, compact: true },
};
