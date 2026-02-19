import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    const isMac = process.platform === 'darwin';
    const isLinux = process.platform === 'linux';
    const isWindows = process.platform === 'win32';

    const hour = new Date().getHours();
    notificationService.updateConfig({
      quietHoursStart: hour,
      quietHoursEnd: (hour + 1) % 24,
    });

    if (isMac) {
      mockSendMacNotification.mockResolvedValue(undefined);
    } else if (isLinux) {
      mockSendLinuxNotification.mockResolvedValue(undefined);
    } else if (isWindows) {
      mockExecCommand.mockResolvedValue(undefined);
    }

    await expect(
      notificationService.notify('Forced', 'Send', { forceSend: true })
    ).resolves.toEqual({
      sent: true,
    });

    if (isMac) {
      expect(mockSendMacNotification).toHaveBeenCalledWith('Forced', 'Send', 'Glass');
    } else if (isLinux) {
      expect(mockSendLinuxNotification).toHaveBeenCalledWith('Forced', 'Send');
    } else if (isWindows) {
      expect(mockExecCommand).toHaveBeenCalled();
    }

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
});
