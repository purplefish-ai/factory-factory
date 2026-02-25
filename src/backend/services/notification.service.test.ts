import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecCommand = vi.hoisted(() => vi.fn());
const mockSendLinuxNotification = vi.hoisted(() => vi.fn());
const mockSendMacNotification = vi.hoisted(() => vi.fn());
const mockGetNotificationConfig = vi.hoisted(() => vi.fn());

vi.mock('@/backend/lib/shell', () => ({
  execCommand: (...args: unknown[]) => mockExecCommand(...args),
  sendLinuxNotification: (...args: unknown[]) => mockSendLinuxNotification(...args),
  sendMacNotification: (...args: unknown[]) => mockSendMacNotification(...args),
}));

vi.mock('./config.service', () => ({
  configService: {
    getNotificationConfig: () => mockGetNotificationConfig(),
  },
}));

vi.mock('./logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { notificationService } from './notification.service';

describe('notificationService', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNotificationConfig.mockReturnValue({
      soundEnabled: true,
      pushEnabled: true,
      soundFile: undefined,
      quietHoursStart: undefined,
      quietHoursEnd: undefined,
    });
    notificationService.updateConfig({
      soundEnabled: true,
      pushEnabled: true,
      soundFile: undefined,
      quietHoursStart: undefined,
      quietHoursEnd: undefined,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
    });
  });

  it('suppresses notifications when disabled or in quiet hours', async () => {
    notificationService.updateConfig({ pushEnabled: false });
    await expect(notificationService.notify('Title', 'Message')).resolves.toEqual({
      sent: false,
      reason: 'disabled',
    });

    const hour = new Date().getHours();
    notificationService.updateConfig({
      pushEnabled: true,
      quietHoursStart: hour,
      quietHoursEnd: (hour + 1) % 24,
    });
    await expect(notificationService.notify('Quiet', 'Mode')).resolves.toEqual({
      sent: false,
      reason: 'quiet_hours',
    });
  });

  it('sends notifications and handles provider failures', async () => {
    const isMac = process.platform === 'darwin';
    const isLinux = process.platform === 'linux';

    if (isMac) {
      mockSendMacNotification.mockResolvedValue(undefined);
    } else if (isLinux) {
      mockSendLinuxNotification.mockResolvedValue(undefined);
    }

    await expect(notificationService.notify('Task done', 'Review now')).resolves.toEqual({
      sent: true,
    });

    if (isMac) {
      expect(mockSendMacNotification).toHaveBeenCalledWith('Task done', 'Review now', 'Glass');
      mockSendMacNotification.mockRejectedValueOnce(new Error('osascript failed'));
      await expect(notificationService.notify('Task failed', 'Need attention')).resolves.toEqual({
        sent: false,
        reason: 'error',
      });
      return;
    }

    if (isLinux) {
      expect(mockSendLinuxNotification).toHaveBeenCalledWith('Task done', 'Review now');
      mockSendLinuxNotification.mockRejectedValueOnce(new Error('notify-send failed'));
      mockExecCommand.mockRejectedValueOnce(new Error('zenity failed'));
      await expect(notificationService.notify('Task failed', 'Need attention')).resolves.toEqual({
        sent: false,
        reason: 'error',
      });
    }
  });

  it('supports force-send and helper notification methods', async () => {
    const hour = new Date().getHours();
    notificationService.updateConfig({
      quietHoursStart: hour,
      quietHoursEnd: (hour + 1) % 24,
    });
    mockSendMacNotification.mockResolvedValue(undefined);
    await expect(
      notificationService.notify('Forced', 'Send', { forceSend: true })
    ).resolves.toEqual({
      sent: true,
    });

    const notifySpy = vi.spyOn(notificationService, 'notify').mockResolvedValue({ sent: true });

    await notificationService.notifyTaskComplete(
      'Task Alpha',
      'https://github.com/acme/repo/pull/1',
      'feature/a'
    );
    await notificationService.notifyEpicComplete('Epic Alpha');
    await notificationService.notifyTaskFailed('Task Beta', 'command failed');
    await notificationService.notifyCriticalError('codex', 'Epic Beta', 'OOM');
    await notificationService.notifyWorkspaceComplete('Workspace A', 'w1', 2);

    expect(notifySpy).toHaveBeenCalledWith(
      'Workspace Ready: Workspace A',
      'All 2 agents finished and ready for your attention'
    );

    notifySpy.mockRestore();
  });

  it('updates and returns config snapshots', () => {
    notificationService.updateConfig({ pushEnabled: false, soundEnabled: false });
    expect(notificationService.getConfig()).toEqual(
      expect.objectContaining({
        pushEnabled: false,
        soundEnabled: false,
      })
    );
  });

  it('builds a safe PowerShell toast script on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await expect(
      notificationService.notify(
        `Danger $(Get-Process) & <tag> "double" 'single'`,
        `Body $(Invoke-Expression "calc") & <xml> "quote" 'apos'`
      )
    ).resolves.toEqual({ sent: true });

    expect(mockExecCommand).toHaveBeenCalledTimes(1);
    const [command, args] = mockExecCommand.mock.calls[0] as [string, string[]];
    const script = args[1];

    expect(command).toBe('powershell');
    expect(args[0]).toBe('-Command');
    expect(script).toContain("$template = @'");
    expect(script).toContain("'@");
    expect(script).not.toContain('@"');
    expect(script).toContain('\n');
    expect(script).not.toContain("''single''");
    expect(script).toContain(
      'Danger $(Get-Process) &amp; &lt;tag&gt; &quot;double&quot; &apos;single&apos;'
    );
    expect(script).toContain(
      'Body $(Invoke-Expression &quot;calc&quot;) &amp; &lt;xml&gt; &quot;quote&quot; &apos;apos&apos;'
    );
  });
});
