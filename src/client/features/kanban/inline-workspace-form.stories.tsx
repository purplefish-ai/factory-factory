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

/** All requests stay inside this preview transport, including launch button clicks. */
function WorkspaceCreationPreviewSession({
  provider = 'CODEX',
  loading = false,
  catalogLoading = false,
}: {
  provider?: ChatProvider;
  loading?: boolean;
  catalogLoading?: boolean;
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
              if (
                (op.path === 'userSettings.get' && loading) ||
                (op.path === 'userSettings.getProviderOptions' && catalogLoading)
              ) {
                return;
              }
              const responses: Record<string, unknown> = {
                'userSettings.get': {
                  defaultSessionProvider: provider,
                  defaultClaudeModel: 'sonnet',
                  defaultCodexModel: 'six-sol',
                  ratchetEnabled: false,
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
              if (op.type === 'mutation') {
                onCreate(op.input);
              }
              observer.next({ result: { data: responses[op.path] ?? {} } });
              observer.complete();
            }),
      ],
    })
  );
  return (
    <QueryClientProvider client={queryClient}>
      <trpc.Provider client={client} queryClient={queryClient}>
        <div className="w-[min(40rem,calc(100vw-2rem))]">
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
export const Narrow: Story = { parameters: { viewport: { value: 'mobile1' } } };
