import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
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
import { readStorageItem, removeStorageItem, writeStorageItem } from '@/client/lib/browser-storage';
import { DEFAULT_APPEARANCE } from '@/shared/appearance';
import { DEFAULT_TICKET_DISPATCH_PROMPT } from '@/shared/issue-start-prompt';
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
import { onRequest, SettingsStoryProvider } from './settings-sections.story-fixtures';
import { TicketDispatchSettingsSection } from './TicketDispatchSettingsSection';
import { WorktreeCleanupSection } from './WorktreeCleanupSection';

const meta = {
  title: 'Settings/SettingsSections',
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  beforeEach: () => {
    onRequest.mockClear();
    // Settings save failures share one toast id; start each story without an
    // earlier story's toast so a new failure shows a fresh toast.
    toast.dismiss();
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
  const preference = readStorageItem(BROWSER_NOTIFICATIONS_KEY);
  writeStorageItem(BROWSER_NOTIFICATIONS_KEY, JSON.stringify(enabled));
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
      removeStorageItem(BROWSER_NOTIFICATIONS_KEY);
    } else {
      writeStorageItem(BROWSER_NOTIFICATIONS_KEY, preference);
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
    removeStorageItem(APPEARANCE_STORAGE_KEY);
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

export const FailedNotificationSettings: Story = {
  beforeEach: () => mockNotificationPermission('default'),
  render: () => (
    <SettingsStoryProvider failRequests={['userSettings.get']}>
      <NotificationSettingsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      "Couldn't load notification settings"
    );
    await expect(canvas.getByRole('switch', { name: 'Desktop notifications' })).toBeEnabled();
    await expect(
      canvas.queryByRole('switch', { name: 'Play completion sound' })
    ).not.toBeInTheDocument();
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
    await canvas.findByLabelText(/^custom command$/i);
    await userEvent.click(canvas.getByRole('button', { name: 'Test' }));
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('userSettings.testCustomCommand', {
        customCommand: 'code-insiders {workspace}',
      })
    );
  },
};

export const CustomIdeTesting: Story = {
  render: () => (
    <SettingsStoryProvider
      settings={{ preferredIde: 'custom', customIdeCommand: 'code-insiders {workspace}' }}
      pendingRequests={['userSettings.testCustomCommand']}
    >
      <IdeSettingsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByLabelText(/^custom command$/i);
    await userEvent.click(canvas.getByRole('button', { name: 'Test' }));
    const testing = await canvas.findByRole('button', { name: 'Testing…' });
    await expect(testing).toBeDisabled();
    await expect(testing).toHaveAttribute('aria-busy', 'true');
    await expect(canvas.getByRole('button', { name: 'Save' })).toBeEnabled();
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

export const TurnLimit: Story = {
  render: () => (
    <SettingsStoryProvider settings={{ turnLimitMinutes: 240 }}>
      <ChatProviderDefaultsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const select = await canvas.findByLabelText('Turn limit');
    await expect(select).toHaveTextContent('4 hours');
    await userEvent.click(select);
    await userEvent.click(await within(document.body).findByRole('option', { name: 'Unlimited' }));
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('userSettings.update', {
        turnLimitMinutes: null,
      })
    );
  },
};

export const CustomTurnLimit: Story = {
  render: () => (
    <SettingsStoryProvider settings={{ turnLimitMinutes: 1 }}>
      <ChatProviderDefaultsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByLabelText('Turn limit')).toHaveTextContent(
      '1 minute'
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

export const AutomationPermissionDefaults: Story = {
  render: () => (
    <SettingsStoryProvider
      settings={{ defaultWorkspacePermissions: 'YOLO', automationPermissions: 'RELAXED' }}
    >
      <ChatProviderDefaultsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const permissions = await canvas.findByLabelText('Automation permissions');
    await expect(permissions).toHaveTextContent('Auto review');
    await userEvent.click(permissions);
    await userEvent.click(await within(document.body).findByRole('option', { name: 'Standard' }));
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('userSettings.update', {
        automationPermissions: 'STRICT',
      })
    );
  },
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
        project={{
          id: 'project-1',
          slug: 'alpha',
          name: 'Alpha',
          issueProvider: 'GITHUB',
          issueTrackerConfig: null,
        }}
      />
    </SettingsStoryProvider>
  ),
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

/** Export is a mutation: the button shows its pending state until the data arrives. */
export const BackupExporting: Story = {
  render: () => (
    <SettingsStoryProvider pendingRequests={['admin.exportData']}>
      <DataImportResultsProvider>
        <DataBackupSection />
      </DataImportResultsProvider>
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Export data' }));
    const exporting = await canvas.findByRole('button', { name: 'Exporting…' });
    await expect(exporting).toBeDisabled();
    await expect(exporting).toHaveAttribute('aria-busy', 'true');
  },
};

export const BackupExportFailure: Story = {
  render: () => (
    <SettingsStoryProvider failRequests={['admin.exportData']}>
      <DataImportResultsProvider>
        <DataBackupSection />
      </DataImportResultsProvider>
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Export data' }));
    await within(document.body).findByText("Couldn't export backup.");
    await expect(canvas.getByRole('button', { name: 'Export data' })).toBeEnabled();
  },
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
    await expect(onRequest).not.toHaveBeenCalledWith('userSettings.update', expect.anything());
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
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
    await within(document.body).findByText("Couldn't save settings.");
    await within(document.body).findByText('Request rejected: userSettings.update');
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
    await expect(link).toHaveAttribute('href', '/admin/logs');
    await expect(within(link).queryByRole('button')).not.toBeInTheDocument();
    link.focus();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: /^download log file$/i })).toHaveFocus();
  },
};

export const ServerLogsDownloading: Story = {
  render: () => (
    <SettingsStoryProvider pendingRequests={['admin.downloadLogFile']}>
      <ServerLogsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Download log file' }));
    const downloading = await canvas.findByRole('button', { name: 'Downloading…' });
    await expect(downloading).toBeDisabled();
    await expect(downloading).toHaveAttribute('aria-busy', 'true');
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
    await within(canvasElement.ownerDocument.body).findByText("Couldn't save settings.");
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
      "Couldn't load child workspace settings"
    );
    await expect(canvas.queryByRole('switch')).not.toBeInTheDocument();
  },
};

export const TicketDispatchPrompt: Story = {
  render: () => (
    <SettingsStoryProvider>
      <TicketDispatchSettingsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByLabelText('Prompt');
    await waitFor(() => expect(input).toBeEnabled());
    await userEvent.clear(input);
    await userEvent.type(input, 'Handle carefully.');
    await userEvent.click(canvas.getByRole('button', { name: 'Save prompt' }));
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('userSettings.update', {
        ticketDispatchPrompt: 'Handle carefully.',
      })
    );
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: 'Reset to default' })).toBeEnabled()
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('userSettings.update', { ticketDispatchPrompt: null })
    );
    await waitFor(() => expect(input).toHaveValue(DEFAULT_TICKET_DISPATCH_PROMPT));
  },
};
export const CustomTicketDispatchPrompt: Story = {
  render: () => (
    <SettingsStoryProvider
      settings={{ ticketDispatchPrompt: 'Implement the ticket and run tests.' }}
    >
      <TicketDispatchSettingsSection />
    </SettingsStoryProvider>
  ),
};
export const LoadingTicketDispatchPrompt: Story = {
  render: () => (
    <SettingsStoryProvider loading>
      <TicketDispatchSettingsSection />
    </SettingsStoryProvider>
  ),
};
export const FailedTicketDispatchPrompt: Story = {
  render: () => (
    <SettingsStoryProvider failRequests={['userSettings.get']}>
      <TicketDispatchSettingsSection />
    </SettingsStoryProvider>
  ),
};

export const CustomFontExplicitSave: Story = {
  render: () => (
    <SettingsStoryProvider>
      <AppearanceSettingsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByLabelText('Interface font'));
    await userEvent.click(await within(document.body).findByRole('option', { name: 'Custom…' }));
    const font = canvas.getByRole('textbox', { name: 'Interface font family' });
    await userEvent.type(font, 'OpenDyslexic, sans-serif');
    await userEvent.tab();
    await expect(onRequest).not.toHaveBeenCalledWith('userSettings.update', expect.anything());
    await userEvent.click(canvas.getByRole('button', { name: 'Save interface font' }));
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('userSettings.update', {
        appearanceFontSans: 'OpenDyslexic, sans-serif',
      })
    );
  },
};
export const CustomFontSaveFailure: Story = {
  render: () => (
    <SettingsStoryProvider failRequests={['userSettings.update']}>
      <AppearanceSettingsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByLabelText('Interface font'));
    await userEvent.click(await within(document.body).findByRole('option', { name: 'Custom…' }));
    await userEvent.type(
      canvas.getByRole('textbox', { name: 'Interface font family' }),
      'OpenDyslexic, sans-serif'
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Save interface font' }));
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith('userSettings.update', {
        appearanceFontSans: 'OpenDyslexic, sans-serif',
      })
    );
    const toastTitle = await within(document.body).findByText("Couldn't save settings.");
    // The toast fades in after it mounts.
    await waitFor(() => expect(toastTitle).toBeVisible());
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: 'Save interface font' })).toBeEnabled()
    );
    await expect(canvas.getByRole('textbox', { name: 'Interface font family' })).toHaveValue(
      'OpenDyslexic, sans-serif'
    );
  },
};

export const FailedRatchetSettings: Story = {
  render: () => (
    <SettingsStoryProvider failRequests={['userSettings.get']}>
      <RatchetSettingsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      "Couldn't load PR update settings"
    );
    await expect(canvas.getByRole('button', { name: 'Retry' })).toBeEnabled();
    await expect(canvas.queryByRole('switch')).not.toBeInTheDocument();
    await expect(canvas.queryByRole('combobox')).not.toBeInTheDocument();
  },
};

export const SavingChildWorkspaces: Story = {
  render: () => (
    <SettingsStoryProvider pendingRequests={['userSettings.update']}>
      <ChildWorkspaceSettingsSection />
    </SettingsStoryProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole('switch', { name: 'Enable child workspaces' });
    await userEvent.click(toggle);
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeEnabled();
    await expect(await canvas.findByRole('status', { name: 'Saving' })).toBeVisible();
  },
};
