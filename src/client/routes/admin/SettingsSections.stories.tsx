import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { ThemeProvider } from 'next-themes';
import { type ReactNode, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { AppearanceProvider } from '@/client/components/appearance-provider';
import { ProviderCliWarning } from '@/client/components/provider-cli-warning';
import { DataImportResultsProvider } from '@/client/features/data-import';
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearance,
  COLOR_SCHEME_ATTRIBUTE,
} from '@/client/lib/appearance';
import { BROWSER_NOTIFICATIONS_KEY } from '@/client/lib/browser-notifications';
import { trpc } from '@/client/lib/trpc';
import { DEFAULT_APPEARANCE } from '@/shared/appearance';
import type { FactoryConfig } from '@/shared/schemas/factory-config.schema';
import { AppearanceSettingsSection } from './AppearanceSettingsSection';
import { AppInfoSection } from './AppInfoSection';
import { ChatProviderDefaultsSection } from './ChatProviderDefaultsSection';
import { ChildWorkspaceSettingsSection } from './ChildWorkspaceSettingsSection';
import { CliAuthSection } from './CliAuthSection';
import { DataBackupSection } from './DataBackupSection';
import { IdeSettingsSection } from './IdeSettingsSection';
import { NotificationSettingsSection } from './NotificationSettingsSection';
import { ProjectFactoryConfigCard } from './ProjectFactoryConfigCard';
import { ProjectSettingsSection } from './ProjectSettingsSection';
import { RatchetSettingsSection } from './RatchetSettingsSection';
import { ServerLogsSection } from './ServerLogsSection';
import { WorktreeCleanupSection } from './WorktreeCleanupSection';

const onRequest = fn<(path: string, input: unknown) => void>();
const defaultSettings = {
  playSoundOnComplete: true,
  childWorkspacesEnabled: true,
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
  appearanceColorScheme: 'factory',
  appearanceBackgroundColor: null as string | null,
  appearanceForegroundColor: null as string | null,
  appearanceFontScale: 100,
  appearanceFontSans: null as string | null,
  appearanceFontMono: null as string | null,
};

// A local transport keeps these interactive examples independent of a running backend.
function SettingsStoryProvider({
  children,
  settings: initialSettings = {},
  loading = false,
  refreshDelayMs = 0,
  failRequests = [],
  factoryConfig = null,
}: {
  children: ReactNode;
  settings?: Partial<typeof defaultSettings>;
  loading?: boolean;
  refreshDelayMs?: number;
  failRequests?: string[];
  factoryConfig?: FactoryConfig | null;
}) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [client] = useState(() => {
    let settings = { ...defaultSettings, ...initialSettings };
    let orphanedWorktrees = [
      {
        projectId: 'project-1',
        projectName: 'factory-factory',
        path: '/Users/me/factory-factory/worktrees/factory-factory/workspace-abc123',
      },
      {
        projectId: 'project-1',
        projectName: 'factory-factory',
        path: '/Users/me/factory-factory/worktrees/factory-factory/workspace-def456',
      },
    ];
    const responses: Record<string, (input: unknown) => unknown> = {
      'codexAccounts.list': () => [],
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
      'admin.checkCLIHealth': (input) => {
        const fresh =
          typeof input === 'object' &&
          input !== null &&
          'forceRefresh' in input &&
          input.forceRefresh === true;
        return {
          claude: { isInstalled: true, isAuthenticated: fresh },
          codex: { isInstalled: true, isAuthenticated: fresh },
          github: { isInstalled: true, isAuthenticated: fresh },
          allHealthy: fresh,
        };
      },
      'admin.downloadLogFile': () => 'Sample server log',
      'admin.getServerInfo': () => ({ backendPort: 3001 }),
      'admin.triggerRatchetCheck': () => ({ checked: 3, stateChanges: 1, actionsTriggered: 1 }),
      'workspace.getFactoryConfig': () => factoryConfig,
      'workspace.refreshFactoryConfigs': () => ({ updatedCount: 2, errors: [] }),
      'admin.listOrphanedWorktrees': () => orphanedWorktrees,
      'admin.removeOrphanedWorktrees': () => {
        const removed = orphanedWorktrees.map((orphan) => orphan.path);
        orphanedWorktrees = [];
        return { removed, failed: [] };
      },
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
    const dispatchResponse = (path: string, send: () => void) => {
      if (path === 'userSettings.get' && refreshDelayMs > 0) {
        const timer = setTimeout(send, refreshDelayMs);
        return () => clearTimeout(timer);
      }
      send();
      return;
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
              const send = () => {
                observer.next({ result: { data: respond(op.input) } });
                observer.complete();
              };
              return dispatchResponse(op.path, send);
            }),
      ],
    });
  });
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {/* Toasts render in the app Toaster that .storybook/preview.ts mounts. */}
        <div className="mx-auto w-full max-w-3xl">{children}</div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: 'Settings/SettingsSections',
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  beforeEach: () => {
    onRequest.mockClear();
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const onPermissionRequest = fn<() => Promise<NotificationPermission>>();
function mockNotificationPermission(
  permission: NotificationPermission | 'unsupported',
  enabled = false
) {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'Notification');
  const preference = localStorage.getItem(BROWSER_NOTIFICATIONS_KEY);
  localStorage.setItem(BROWSER_NOTIFICATIONS_KEY, JSON.stringify(enabled));
  const api = {
    permission,
    requestPermission: () => onPermissionRequest(),
  };
  onPermissionRequest.mockReset();
  onPermissionRequest.mockImplementation(() => {
    api.permission = 'granted';
    return Promise.resolve('granted');
  });
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: permission === 'unsupported' ? undefined : api,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(window, 'Notification', descriptor);
    } else {
      Reflect.deleteProperty(window, 'Notification');
    }
    if (preference === null) {
      localStorage.removeItem(BROWSER_NOTIFICATIONS_KEY);
    } else {
      localStorage.setItem(BROWSER_NOTIFICATIONS_KEY, preference);
    }
  };
}

export const Notifications: Story = {
  beforeEach: () => mockNotificationPermission('default'),
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
    const desktop = canvas.getByRole('switch', { name: 'Desktop notifications' });
    await expect(desktop).not.toBeChecked();
    await expect(onPermissionRequest).not.toHaveBeenCalled();
    await userEvent.click(desktop);
    await waitFor(() => expect(desktop).toBeChecked());
    await expect(onPermissionRequest).toHaveBeenCalledOnce();
    await userEvent.click(desktop);
    await expect(desktop).not.toBeChecked();
  },
};

export const NotificationsDark: Story = { ...Notifications, globals: { theme: 'dark' } };
export const NotificationsPhone: Story = {
  ...Notifications,
  globals: { viewport: { value: 'phone', isRotated: false } },
};
export const NotificationsEnabled: Story = {
  ...Notifications,
  beforeEach: () => mockNotificationPermission('granted', true),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('switch', { name: 'Desktop notifications' })
    ).toBeChecked();
    await expect(
      canvas.getByText('On for this browser. Select a notification to open its workspace.')
    ).toBeVisible();
  },
};
export const NotificationsBlocked: Story = {
  ...Notifications,
  beforeEach: () => mockNotificationPermission('denied'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('switch', { name: 'Desktop notifications' })
    ).toBeDisabled();
    await expect(canvas.getByText(/Allow them in your browser settings/)).toBeVisible();
  },
};
export const NotificationsUnsupported: Story = {
  ...Notifications,
  beforeEach: () => mockNotificationPermission('unsupported'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('switch', { name: 'Desktop notifications' })
    ).toBeDisabled();
    await expect(
      canvas.getByText("This browser doesn't support desktop notifications.")
    ).toBeVisible();
  },
};
export const NotificationsPermissionError: Story = {
  ...Notifications,
  beforeEach: () => {
    const restore = mockNotificationPermission('default');
    onPermissionRequest.mockRejectedValue(new Error('Permission API failed'));
    return restore;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const desktop = await canvas.findByRole('switch', { name: 'Desktop notifications' });
    await userEvent.click(desktop);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      "Couldn't enable notifications"
    );
    await expect(desktop).not.toBeChecked();
  },
};

// The Mode selector talks to next-themes, which the app provides in RootLayout.
function AppearanceStoryProvider({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" storageKey="storybook-appearance-theme" enableSystem={false}>
      {children}
    </ThemeProvider>
  );
}

export const Appearance: Story = {
  // The app's AppearanceProvider applies the saved preset to <html>, so picking
  // Solarized restyles the story as it would the app. Restore the page after.
  beforeEach: () => () => {
    applyAppearance(DEFAULT_APPEARANCE);
    localStorage.removeItem(APPEARANCE_STORAGE_KEY);
  },
  render: () => (
    <AppearanceStoryProvider>
      <SettingsStoryProvider>
        <AppearanceProvider>
          <AppearanceSettingsSection />
        </AppearanceProvider>
      </SettingsStoryProvider>
    </AppearanceStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const fontSize = await canvas.findByRole('slider', { name: 'Font size' });
    await expect(fontSize).toHaveAttribute('aria-valuetext', '100%');
    await userEvent.click(await canvas.findByLabelText('Color scheme'));
    await userEvent.click(await within(document.body).findByRole('option', { name: 'Solarized' }));
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('userSettings.update', {
        appearanceColorScheme: 'solarized',
      })
    );
    await waitFor(() =>
      expect(canvas.getByLabelText('Color scheme')).toHaveTextContent('Solarized')
    );
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute(COLOR_SCHEME_ATTRIBUTE, 'solarized')
    );
    // The select hides the rest of the page from assistive tech until its
    // closing animation ends.
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: 'Reset appearance' })).toBeEnabled()
    );
  },
};

export const CustomizedAppearance: Story = {
  render: () => (
    <SettingsStoryProvider
      settings={{
        appearanceColorScheme: 'high-contrast',
        appearanceBackgroundColor: '#000000',
        appearanceForegroundColor: '#ffff00',
        appearanceFontScale: 125,
        appearanceFontSans: '"Inter", ui-sans-serif, system-ui, sans-serif',
        appearanceFontMono: 'Fira Code',
      }}
    >
      <AppearanceStoryProvider>
        <AppearanceSettingsSection />
      </AppearanceStoryProvider>
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByLabelText('Monospace font')).toHaveTextContent('Custom');
    await expect(canvas.getByRole('textbox', { name: 'Monospace font family' })).toHaveValue(
      'Fira Code'
    );
    await expect(canvas.getByText('125%')).toBeVisible();
  },
};

export const LoadingAppearance: Story = {
  render: () => (
    <SettingsStoryProvider loading>
      <AppearanceStoryProvider>
        <AppearanceSettingsSection />
      </AppearanceStoryProvider>
    </SettingsStoryProvider>
  ),
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
    await canvas.findByLabelText(/^custom command$/i);
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

export const NativePermissionDefaults: Story = {
  render: () => (
    <SettingsStoryProvider settings={{ defaultWorkspacePermissions: 'RELAXED' }}>
      <ChatProviderDefaultsSection />
    </SettingsStoryProvider>
  ),
};

export const ChatDefaultsSlowRefresh: Story = {
  render: () => (
    <SettingsStoryProvider refreshDelayMs={1500}>
      <ChatProviderDefaultsSection />
    </SettingsStoryProvider>
  ),
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
    await userEvent.click(await canvas.findByRole('button', { name: /^check all prs now$/i }));
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
      {/* The app root provides import results to the import button. */}
      <DataImportResultsProvider>
        <DataBackupSection />
      </DataImportResultsProvider>
    </SettingsStoryProvider>
  ),
};

export const WorktreeCleanup: Story = {
  render: () => (
    <SettingsStoryProvider>
      <WorktreeCleanupSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Found 2 orphaned worktrees not used by any active workspace.');
    await userEvent.click(canvas.getByRole('button', { name: /^remove orphaned worktrees$/i }));
    const dialog = within(document.body);
    await userEvent.click(await dialog.findByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('admin.removeOrphanedWorktrees', undefined)
    );
    await canvas.findByText('No orphaned worktrees found.');
  },
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
    const command = await canvas.findByRole('textbox', { name: /^custom command$/i });
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
      "Couldn't update chat defaults. Request rejected: userSettings.update"
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
    await userEvent.click(within(dialog).getByRole('button', { name: /^save configuration$/i }));
    await within(dialog).findByText('Error: Request rejected: project.saveFactoryConfig');
    await within(document.body).findByText(
      "Couldn't save configuration. Request rejected: project.saveFactoryConfig"
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
    const link = canvas.getByRole('link', { name: /^view logs$/i });
    await expect(link).toHaveAttribute('href', '/logs');
    await expect(within(link).queryByRole('button')).not.toBeInTheDocument();
    link.focus();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: /^download log file$/i })).toHaveFocus();
  },
};

export const RefreshCLIAuthentication: Story = {
  render: () => (
    <SettingsStoryProvider>
      <CliAuthSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/use Sign in to Claude/);
    await expect(canvas.getByText(/Sign in to Codex/)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Recheck' }));
    await waitFor(() => expect(canvas.getAllByText(/Ready/)).toHaveLength(3));
    await expect(
      canvas.queryByRole('button', { name: /^open terminal to log in$/i })
    ).not.toBeInTheDocument();
  },
};

export const ManagedProviderLoginActions: Story = {
  render: () => (
    <SettingsStoryProvider>
      <CliAuthSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: /^open terminal to log in$/i })
    );
    const dialog = within(await within(document.body).findByRole('dialog', { name: 'Terminal' }));
    // The dialog fades in.
    await waitFor(() =>
      expect(dialog.getByRole('button', { name: 'Sign in to Claude' })).toBeVisible()
    );
    await expect(dialog.getByRole('button', { name: 'Sign in to Codex' })).toBeVisible();
  },
};

export const ManagedCodexLogin: Story = {
  render: () => (
    <SettingsStoryProvider>
      <ProviderCliWarning provider="CODEX" />
    </SettingsStoryProvider>
  ),
};

export const ChildWorkspaces: Story = {
  render: () => (
    <SettingsStoryProvider>
      <ChildWorkspaceSettingsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const toggle = await within(canvasElement).findByRole('switch', {
      name: 'Enable child workspaces',
    });
    await expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
  },
};
export const DisabledChildWorkspaces: Story = {
  render: () => (
    <SettingsStoryProvider settings={{ childWorkspacesEnabled: false }}>
      <ChildWorkspaceSettingsSection />
    </SettingsStoryProvider>
  ),
};
export const LoadingChildWorkspaces: Story = {
  render: () => (
    <SettingsStoryProvider loading>
      <ChildWorkspaceSettingsSection />
    </SettingsStoryProvider>
  ),
};
export const RejectedChildWorkspaces: Story = {
  render: () => (
    <SettingsStoryProvider failRequests={['userSettings.update']}>
      <ChildWorkspaceSettingsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const toggle = await within(canvasElement).findByRole('switch', {
      name: 'Enable child workspaces',
    });
    await expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('userSettings.update', {
        childWorkspacesEnabled: false,
      })
    );
    await within(canvasElement.ownerDocument.body).findByText(
      "Couldn't update settings. Request rejected: userSettings.update"
    );
    await expect(toggle).toBeChecked();
  },
};
export const FailedChildWorkspaceSettings: Story = {
  render: () => (
    <SettingsStoryProvider failRequests={['userSettings.get']}>
      <ChildWorkspaceSettingsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      "Couldn't load child workspace settings."
    );
    await expect(canvas.queryByRole('switch')).not.toBeInTheDocument();
  },
};
