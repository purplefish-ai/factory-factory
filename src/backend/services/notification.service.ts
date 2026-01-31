/**
 * Desktop Notification Service
 *
 * Provides cross-platform desktop notifications for important events.
 * Supports macOS, Linux, and Windows.
 */

import { execCommand, sendLinuxNotification, sendMacNotification } from '../lib/shell';
import { configService, type NotificationConfig } from './config.service';
import { createLogger } from './logger.service';

const logger = createLogger('notification');

/**
 * Get notification configuration from centralized config service
 */
function getConfig(): NotificationConfig {
  return configService.getNotificationConfig();
}

/**
 * Check if we're currently in quiet hours
 */
function isQuietHours(config: NotificationConfig): boolean {
  if (config.quietHoursStart === undefined || config.quietHoursEnd === undefined) {
    return false;
  }

  const now = new Date();
  const currentHour = now.getHours();

  // Handle overnight quiet hours (e.g., 22:00 to 08:00)
  if (config.quietHoursStart > config.quietHoursEnd) {
    return currentHour >= config.quietHoursStart || currentHour < config.quietHoursEnd;
  }

  // Handle same-day quiet hours (e.g., 12:00 to 14:00)
  return currentHour >= config.quietHoursStart && currentHour < config.quietHoursEnd;
}

/**
 * Send macOS notification using osascript (local wrapper for platform-specific logic)
 */
async function sendMacOSNotificationLocal(
  title: string,
  message: string,
  soundEnabled: boolean
): Promise<void> {
  try {
    await sendMacNotification(title, message, soundEnabled ? 'Glass' : undefined);
    logger.debug('macOS notification sent', { title });
  } catch (error) {
    logger.error('Failed to send macOS notification', error as Error, { title });
    throw error;
  }
}

/**
 * Send Linux notification using notify-send (local wrapper for platform-specific logic)
 */
async function sendLinuxNotificationLocal(title: string, message: string): Promise<void> {
  try {
    await sendLinuxNotification(title, message);
    logger.debug('Linux notification sent', { title });
  } catch (error) {
    // Try alternative tools if notify-send is not available
    try {
      await execCommand('zenity', ['--notification', `--text=${title}: ${message}`]);
      logger.debug('Linux notification sent via zenity', { title });
    } catch {
      logger.error(
        'Failed to send Linux notification (notify-send and zenity unavailable)',
        error as Error,
        { title }
      );
      throw error;
    }
  }
}

/**
 * Send Windows notification using PowerShell
 */
async function sendWindowsNotification(title: string, message: string): Promise<void> {
  // Escape for PowerShell single quotes
  const escapedTitle = title.replace(/'/g, "''");
  const escapedMessage = message.replace(/'/g, "''");

  const psScript = `
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

    $template = @"
    <toast>
        <visual>
            <binding template="ToastText02">
                <text id="1">${escapedTitle}</text>
                <text id="2">${escapedMessage}</text>
            </binding>
        </visual>
    </toast>
"@

    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($template)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("FactoryFactory").Show($toast)
  `.replace(/\n/g, ' ');

  try {
    // Use spawn with array args for safety
    await execCommand('powershell', ['-Command', psScript]);
    logger.debug('Windows notification sent', { title });
  } catch (error) {
    logger.error('Failed to send Windows notification', error as Error, { title });
    throw error;
  }
}

/**
 * Play a sound file
 */
async function playSound(soundFile?: string): Promise<void> {
  const platform = process.platform;

  try {
    switch (platform) {
      case 'darwin': {
        // macOS: Use afplay with spawn (safe)
        const file = soundFile || '/System/Library/Sounds/Glass.aiff';
        await execCommand('afplay', [file]);
        break;
      }

      case 'linux': {
        // Linux: Try paplay first (PulseAudio), then aplay (ALSA)
        const file = soundFile || '/usr/share/sounds/freedesktop/stereo/complete.oga';
        try {
          await execCommand('paplay', [file]);
        } catch {
          if (soundFile) {
            await execCommand('aplay', [file]);
          } else {
            logger.debug('No system sound available on Linux');
          }
        }
        break;
      }

      case 'win32': {
        // Windows: Use PowerShell SoundPlayer with spawn (safe)
        if (soundFile) {
          const escapedPath = soundFile.replace(/'/g, "''");
          await execCommand('powershell', [
            '-Command',
            `(New-Object Media.SoundPlayer '${escapedPath}').PlaySync()`,
          ]);
        } else {
          // Use system sound
          await execCommand('powershell', [
            '-Command',
            '[System.Media.SystemSounds]::Asterisk.Play()',
          ]);
        }
        break;
      }

      default:
        logger.debug('Sound playback not supported', { platform });
    }
  } catch (error) {
    logger.error('Failed to play sound', error as Error);
    // Don't throw - sound is optional
  }
}

/**
 * Send a platform-specific push notification
 */
async function sendPushNotification(
  title: string,
  message: string,
  soundEnabled: boolean
): Promise<void> {
  const platform = process.platform;

  switch (platform) {
    case 'darwin':
      await sendMacOSNotificationLocal(title, message, soundEnabled);
      break;

    case 'linux':
      await sendLinuxNotificationLocal(title, message);
      break;

    case 'win32':
      await sendWindowsNotification(title, message);
      break;

    default:
      logger.debug('Notifications not supported', { platform });
  }
}

/**
 * NotificationService class - main interface for sending notifications
 */
class NotificationService {
  private config: NotificationConfig;

  constructor(config?: Partial<NotificationConfig>) {
    this.config = {
      ...getConfig(),
      ...config,
    };
  }

  /**
   * Send a desktop notification
   *
   * @param title - Notification title
   * @param message - Notification body
   * @param options - Optional override options
   */
  async notify(
    title: string,
    message: string,
    options?: {
      forceSend?: boolean; // Ignore quiet hours
      playSound?: boolean; // Override sound setting
    }
  ): Promise<{ sent: boolean; reason?: string }> {
    // Check quiet hours
    if (!options?.forceSend && isQuietHours(this.config)) {
      logger.debug('Notification suppressed (quiet hours)', { title });
      return { sent: false, reason: 'quiet_hours' };
    }

    // Check if push notifications are enabled
    if (!this.config.pushEnabled) {
      logger.debug('Notification suppressed (disabled)', { title });
      return { sent: false, reason: 'disabled' };
    }

    try {
      // Send push notification
      await sendPushNotification(title, message, options?.playSound ?? this.config.soundEnabled);

      // Play additional sound if enabled and not already played by notification
      if ((options?.playSound ?? this.config.soundEnabled) && process.platform === 'linux') {
        // Linux notify-send doesn't play sound, so we play it separately
        await playSound(this.config.soundFile);
      }

      logger.debug('Notification sent', { title });
      return { sent: true };
    } catch (error) {
      logger.error('Failed to send notification', error as Error, { title });
      return { sent: false, reason: 'error' };
    }
  }

  /**
   * Send a task completion notification
   */
  async notifyTaskComplete(taskTitle: string, prUrl?: string, branchName?: string): Promise<void> {
    const message = prUrl
      ? `PR ready for review\nBranch: ${branchName || 'unknown'}\nPR: ${prUrl}`
      : `Task completed successfully`;

    await this.notify(`Task Complete: ${taskTitle}`, message);
  }

  /**
   * Send an epic completion notification
   */
  async notifyEpicComplete(epicTitle: string, prUrl?: string): Promise<void> {
    const message = prUrl
      ? `All tasks finished\nEpic PR: ${prUrl}\nReady for your review`
      : `All tasks completed. Epic is ready for review.`;

    await this.notify(`Epic Complete: ${epicTitle}`, message);
  }

  /**
   * Send a task failure notification
   */
  async notifyTaskFailed(taskTitle: string, reason?: string): Promise<void> {
    const message = reason || 'Failed after maximum attempts\nRequires manual intervention';

    await this.notify(`Task Failed: ${taskTitle}`, message, { forceSend: true });
  }

  /**
   * Send a critical error notification
   */
  async notifyCriticalError(
    agentType: string,
    epicTitle?: string,
    details?: string
  ): Promise<void> {
    const message = epicTitle
      ? `${agentType} crashed\nEpic: ${epicTitle}\n${details || 'Check logs for details'}`
      : `${agentType} crashed\n${details || 'Check logs for details'}`;

    await this.notify(`CRITICAL: Agent Error`, message, { forceSend: true });
  }

  /**
   * Send a generic notification
   */
  async notifyHuman(title: string, message: string): Promise<void> {
    await this.notify(title, message);
  }

  /**
   * Get current configuration
   */
  getConfig(): NotificationConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<NotificationConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }
}

// Export singleton instance
export const notificationService = new NotificationService();
