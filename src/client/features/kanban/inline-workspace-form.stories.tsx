import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { trpc } from '@/client/lib/trpc';
import type { ChatProvider } from '@/shared/chat-capabilities';
import { InlineWorkspaceForm } from './inline-workspace-form';

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
  };
}

function previewResponse(path: string, input: unknown, provider: ChatProvider) {
  if (path === 'session.getLaunchOptions') {
    return previewLaunchOptions(input);
  }
  const responses: Record<string, unknown> = {
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
          { value: 'six-sol', label: '6 Sol' },
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
      mode: 'STANDARD',
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
}: {
  provider?: ChatProvider;
  loading?: boolean;
  catalogLoading?: boolean;
  compact?: boolean;
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
          style={{
            width: compact ? 'min(20rem, calc(100vw - 2rem))' : 'min(40rem, calc(100vw - 2rem))',
          }}
        >
          <InlineWorkspaceForm
            projectId="preview-project"
            existingNames={[]}
            onCreated={fn()}
            onCancel={onCancel}
          />
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
}) {
  const key = `${props.provider ?? 'CODEX'}:${Boolean(props.loading)}:${Boolean(props.catalogLoading)}`;
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
export const SavedClaudeDefaults: Story = { args: { provider: 'CLAUDE' } };
export const Dark: Story = { globals: { theme: 'dark' } };
export const Loading: Story = { args: { loading: true } };
export const CatalogLoading: Story = { args: { catalogLoading: true } };
export const Narrow: Story = {
  args: { compact: true },
  parameters: { viewport: { value: 'mobile1' } },
};
export const NarrowDark: Story = { ...Narrow, globals: { theme: 'dark' } };
