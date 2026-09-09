import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { type ReactNode, useState } from 'react';
import { Toaster } from 'sonner';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { trpc } from '@/client/lib/trpc';
import type { FactoryConfig } from '@/shared/schemas/factory-config.schema';
import { AppInfoSection } from './AppInfoSection';
import { ChatProviderDefaultsSection } from './ChatProviderDefaultsSection';
import { DataBackupSection } from './DataBackupSection';
import { IdeSettingsSection } from './IdeSettingsSection';
import { NotificationSettingsSection } from './NotificationSettingsSection';
import { ProjectFactoryConfigCard } from './ProjectFactoryConfigCard';
import { ProjectSettingsSection } from './ProjectSettingsSection';
import { RatchetSettingsSection } from './RatchetSettingsSection';
import { ServerLogsSection } from './ServerLogsSection';

const onRequest = fn<(path: string, input: unknown) => void>();
const defaultSettings = {
  playSoundOnComplete: true,
  preferredIde: 'cursor',
  customIdeCommand: null as string | null,
  defaultSessionProvider: 'CLAUDE',
  defaultClaudeModel: 'sonnet',
  defaultCodexModel: 'default',
  defaultClaudeReasoningEffort: null,
  defaultCodexReasoningEffort: null,
  defaultWorkspacePermissions: 'STRICT',
  ratchetEnabled: false,
  ratchetReplyToPrComments: true,
  ratchetReviewTriggerMode: 'CHANGES_REQUESTED',
  ratchetPermissions: 'YOLO',
};

// A local transport keeps these interactive examples independent of a running backend.
function SettingsStoryProvider({
  children,
  settings: initialSettings = {},
  loading = false,
  failRequests = [],
  factoryConfig = null,
}: {
  children: ReactNode;
  settings?: Partial<typeof defaultSettings>;
  loading?: boolean;
  failRequests?: string[];
  factoryConfig?: FactoryConfig | null;
}) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [client] = useState(() => {
    let settings = { ...defaultSettings, ...initialSettings };
    const responses: Record<string, (input: unknown) => unknown> = {
      'userSettings.get': () => settings,
      'userSettings.update': (input) => {
        settings = { ...settings, ...(typeof input === 'object' ? input : {}) };
        return settings;
      },
      'userSettings.testCustomCommand': () => ({ success: true }),
      'userSettings.getProviderOptions': () => ({
        CLAUDE: {
          source: 'cli',
          models: [
            { value: 'default', label: 'Default — Opus 4.8 (1M)' },
            { value: 'claude-fable-5[1m]', label: 'Fable 5' },
            { value: 'sonnet', label: 'Sonnet 5' },
          ],
          efforts: [{ value: 'medium', label: 'Medium' }],
        },
        CODEX: {
          source: 'fallback',
          models: [
            { value: 'default', label: 'Default' },
            { value: 'gpt-test', label: 'Test Codex Model' },
          ],
          efforts: [{ value: 'medium', label: 'Medium' }],
        },
      }),
      'admin.checkCLIHealth': () => ({
        claude: { isInstalled: true },
        codex: { isInstalled: true },
      }),
      'admin.downloadLogFile': () => 'Sample server log',
      'admin.getServerInfo': () => ({ backendPort: 3001 }),
      'admin.triggerRatchetCheck': () => ({ checked: 3, stateChanges: 1, actionsTriggered: 1 }),
      'workspace.getFactoryConfig': () => factoryConfig,
      'workspace.refreshFactoryConfigs': () => ({ updatedCount: 2, errors: [] }),
      'admin.exportData': () => ({
        meta: { exportedAt: '2026-09-08T12:00:00Z', version: '0.4.7', schemaVersion: 4 },
        data: {
          projects: [],
          workspaces: [],
          agentSessions: [],
          terminalSessions: [],
          userSettings: null,
        },
      }),
    };
    return trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              onRequest(op.path, op.input);
              if (loading) {
                return;
              }
              if (failRequests.includes(op.path)) {
                observer.error(new TRPCClientError(`Request rejected: ${op.path}`));
                return;
              }
              const respond = responses[op.path];
              if (!respond) {
                observer.error(new TRPCClientError(`No story fixture for ${op.path}`));
                return;
              }
              observer.next({ result: { data: respond(op.input) } });
              observer.complete();
            }),
      ],
    });
  });
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="mx-auto w-full max-w-3xl">{children}</div>
        <Toaster />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: 'Pages/Admin/SettingsSections',
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  beforeEach: () => {
    onRequest.mockClear();
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Notifications: Story = {
  render: () => (
    <SettingsStoryProvider>
      <NotificationSettingsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole('switch', { name: 'Play completion sound' });
    await expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('userSettings.update', { playSoundOnComplete: false })
    );
    await waitFor(() => expect(toggle).not.toBeChecked());
  },
};

export const LoadingNotifications: Story = {
  render: () => (
    <SettingsStoryProvider loading>
      <NotificationSettingsSection />
    </SettingsStoryProvider>
  ),
};

export const CustomIde: Story = {
  render: () => (
    <SettingsStoryProvider
      settings={{ preferredIde: 'custom', customIdeCommand: 'code-insiders {workspace}' }}
    >
      <IdeSettingsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByLabelText('Custom Command');
    await userEvent.click(canvas.getByRole('button', { name: 'Test' }));
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('userSettings.testCustomCommand', {
        customCommand: 'code-insiders {workspace}',
      })
    );
  },
};

export const ChatDefaults: Story = {
  render: () => (
    <SettingsStoryProvider>
      <ChatProviderDefaultsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const select = await canvas.findByLabelText('Default Claude model');
    await userEvent.click(select);
    await userEvent.click(await within(document.body).findByRole('option', { name: 'Fable 5' }));
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('userSettings.update', {
        defaultClaudeModel: 'claude-fable-5[1m]',
      })
    );
  },
};

export const SavedModelOutsideCatalog: Story = {
  render: () => (
    <SettingsStoryProvider settings={{ defaultClaudeModel: 'claude-sonnet-4-5-20250929' }}>
      <ChatProviderDefaultsSection />
    </SettingsStoryProvider>
  ),
};

export const Ratchet: Story = {
  render: () => (
    <SettingsStoryProvider>
      <RatchetSettingsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByLabelText('Review feedback trigger'));
    await userEvent.click(
      await within(document.body).findByRole('option', { name: 'All review feedback' })
    );
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('userSettings.update', {
        ratchetReviewTriggerMode: 'ALL_REVIEW_FEEDBACK',
      })
    );
    await userEvent.click(await canvas.findByRole('button', { name: 'Check All PRs Now' }));
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('admin.triggerRatchetCheck', undefined)
    );
  },
};

export const ProjectSettings: Story = {
  render: () => (
    <SettingsStoryProvider>
      <ProjectSettingsSection
        projects={[
          {
            id: 'project-1',
            slug: 'alpha',
            name: 'Alpha',
            issueProvider: 'GITHUB',
            issueTrackerConfig: null,
          },
          {
            id: 'project-2',
            slug: 'beta',
            name: 'Beta',
            issueProvider: 'GITHUB',
            issueTrackerConfig: null,
          },
        ]}
      />
    </SettingsStoryProvider>
  ),
};

export const NoProjects: Story = {
  render: () => <ProjectSettingsSection projects={[]} />,
};

export const Backup: Story = {
  render: () => (
    <SettingsStoryProvider>
      <DataBackupSection />
    </SettingsStoryProvider>
  ),
};

export const AppInfo: Story = {
  render: () => (
    <SettingsStoryProvider>
      <AppInfoSection />
    </SettingsStoryProvider>
  ),
};

export const CustomIdeFirstSetup: Story = {
  render: () => (
    <SettingsStoryProvider>
      <IdeSettingsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByLabelText('Preferred IDE'));
    await userEvent.click(await within(document.body).findByRole('option', { name: 'Custom' }));
    const command = await canvas.findByRole('textbox', { name: 'Custom Command' });
    await expect(onRequest).not.toHaveBeenCalledWith('userSettings.update', expect.anything());
    await userEvent.type(command, 'code-insiders {{workspace}');
    await userEvent.tab();
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('userSettings.update', {
        preferredIde: 'custom',
        customIdeCommand: 'code-insiders {workspace}',
      })
    );
    await waitFor(() => expect(canvas.getByLabelText('Preferred IDE')).toHaveTextContent('Custom'));
    await expect(command).toBeVisible();
  },
};

export const CustomIdeFromVsCode: Story = {
  render: () => (
    <SettingsStoryProvider settings={{ preferredIde: 'vscode' }}>
      <IdeSettingsSection />
    </SettingsStoryProvider>
  ),
  play: CustomIdeFirstSetup.play,
};

export const RejectedChatModel: Story = {
  render: () => (
    <SettingsStoryProvider failRequests={['userSettings.update']}>
      <ChatProviderDefaultsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const model = await canvas.findByLabelText('Default Claude model');
    await userEvent.click(model);
    await userEvent.click(await within(document.body).findByRole('option', { name: 'Fable 5' }));
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('userSettings.update', {
        defaultClaudeModel: 'claude-fable-5[1m]',
      })
    );
    await waitFor(() => expect(model).toHaveTextContent('Sonnet 5'));
    await within(document.body).findByText(
      'Failed to update chat defaults: Request rejected: userSettings.update'
    );
  },
};

export const LoadingFactoryConfiguration: Story = {
  render: () => (
    <SettingsStoryProvider loading>
      <ProjectFactoryConfigCard projectId="project-1" projectName="Alpha" />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Edit factory configuration' })).toBeDisabled();
    await expect(canvas.getByRole('status')).toHaveTextContent('Loading configuration');
    await expect(canvas.queryByText('Not configured')).not.toBeInTheDocument();
  },
};

export const FailedFactoryConfiguration: Story = {
  render: () => (
    <SettingsStoryProvider failRequests={['workspace.getFactoryConfig']}>
      <ProjectFactoryConfigCard projectId="project-1" projectName="Alpha" />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('alert');
    await expect(canvas.getByRole('button', { name: 'Edit factory configuration' })).toBeDisabled();
    await expect(canvas.queryByText('Not configured')).not.toBeInTheDocument();
  },
};

export const FailedFactorySave: Story = {
  render: () => (
    <SettingsStoryProvider
      factoryConfig={{ scripts: { run: 'pnpm dev', setup: 'pnpm install' } }}
      failRequests={['project.saveFactoryConfig']}
    >
      <ProjectFactoryConfigCard projectId="project-1" projectName="Alpha" />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const edit = await canvas.findByRole('button', { name: 'Edit factory configuration' });
    await waitFor(() => expect(edit).toBeEnabled());
    await userEvent.click(edit);
    const dialog = await within(document.body).findByRole('dialog');
    await expect(within(dialog).getByLabelText(/^Run Command/)).toHaveValue('pnpm dev');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save Configuration' }));
    await within(dialog).findByText('Error: Request rejected: project.saveFactoryConfig');
    await within(document.body).findByText(
      'Failed to save configuration: Request rejected: project.saveFactoryConfig'
    );
    await expect(dialog).toBeVisible();
  },
};

export const ServerLogs: Story = {
  render: () => (
    <SettingsStoryProvider>
      <ServerLogsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = canvas.getByRole('link', { name: 'View Logs' });
    await expect(link).toHaveAttribute('href', '/logs');
    await expect(within(link).queryByRole('button')).not.toBeInTheDocument();
    link.focus();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Download Log File' })).toHaveFocus();
  },
};
