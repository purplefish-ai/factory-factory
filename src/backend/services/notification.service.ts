/**
 * Desktop Notification Service
 *
 * Provides cross-platform desktop notifications for important events.
 * Supports macOS, Linux, and Windows.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Notification configuration
 */
export interface NotificationConfig {
  soundEnabled: boolean;
  pushEnabled: boolean;
  soundFile?: string;
  quietHoursStart?: number; // Hour in 24h format (e.g., 22 for 10 PM)
  quietHoursEnd?: number; // Hour in 24h format (e.g., 8 for 8 AM)
}

/**
 * Get notification configuration from environment variables
 */
function getConfig(): NotificationConfig {
  return {
    soundEnabled: process.env.NOTIFICATION_SOUND_ENABLED !== 'false',
    pushEnabled: process.env.NOTIFICATION_PUSH_ENABLED !== 'false',
    soundFile: process.env.NOTIFICATION_SOUND_FILE,
    quietHoursStart: process.env.NOTIFICATION_QUIET_HOURS_START
      ? Number.parseInt(process.env.NOTIFICATION_QUIET_HOURS_START, 10)
      : undefined,
    quietHoursEnd: process.env.NOTIFICATION_QUIET_HOURS_END
      ? Number.parseInt(process.env.NOTIFICATION_QUIET_HOURS_END, 10)
      : undefined,
  };
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
 * Escape string for shell command
 */
function escapeForShell(str: string): string {
  return str.replace(/'/g, "'\\''");
}

/**
 * Send macOS notification using osascript
 */
async function sendMacOSNotification(
  title: string,
  message: string,
  soundEnabled: boolean
): Promise<void> {
  const escapedTitle = escapeForShell(title);
  const escapedMessage = escapeForShell(message);

  let script = `display notification '${escapedMessage}' with title '${escapedTitle}'`;

  if (soundEnabled) {
    script += ` sound name "Glass"`;
  }

  try {
    await execAsync(`osascript -e "${script.replace(/"/g, '\\"')}"`);
    console.log(`macOS notification sent: ${title}`);
  } catch (error) {
    console.error('Failed to send macOS notification:', error);
    throw error;
  }
}

/**
 * Send Linux notification using notify-send
 */
async function sendLinuxNotification(title: string, message: string): Promise<void> {
  const escapedTitle = escapeForShell(title);
  const escapedMessage = escapeForShell(message);

  try {
    await execAsync(`notify-send '${escapedTitle}' '${escapedMessage}'`);
    console.log(`Linux notification sent: ${title}`);
  } catch (error) {
    // Try alternative tools if notify-send is not available
    try {
      await execAsync(`zenity --notification --text='${escapedTitle}: ${escapedMessage}'`);
      console.log(`Linux notification sent via zenity: ${title}`);
    } catch {
      console.error(
        'Failed to send Linux notification (notify-send and zenity unavailable):',
        error
      );
      throw error;
    }
  }
}

/**
 * Send Windows notification using PowerShell
 */
async function sendWindowsNotification(title: string, message: string): Promise<void> {
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
  `;

  try {
    await execAsync(`powershell -Command "${psScript.replace(/\n/g, ' ')}"`);
    console.log(`Windows notification sent: ${title}`);
  } catch (error) {
    console.error('Failed to send Windows notification:', error);
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
        // macOS: Use afplay
        if (soundFile) {
          await execAsync(`afplay '${escapeForShell(soundFile)}'`);
        } else {
          // Use system sound
          await execAsync(`afplay /System/Library/Sounds/Glass.aiff`);
        }
        break;
      }

      case 'linux': {
        // Linux: Try paplay first (PulseAudio), then aplay (ALSA)
        if (soundFile) {
          try {
            await execAsync(`paplay '${escapeForShell(soundFile)}'`);
          } catch {
            await execAsync(`aplay '${escapeForShell(soundFile)}'`);
          }
        } else {
          // Try to use system sound
          try {
            await execAsync(`paplay /usr/share/sounds/freedesktop/stereo/complete.oga`);
          } catch {
            console.log('No system sound available on Linux');
          }
        }
        break;
      }

      case 'win32': {
        // Windows: Use PowerShell SoundPlayer
        if (soundFile) {
          await execAsync(
            `powershell -Command "(New-Object Media.SoundPlayer '${soundFile.replace(/'/g, "''")}').PlaySync()"`
          );
        } else {
          // Use system sound
          await execAsync(`powershell -Command "[System.Media.SystemSounds]::Asterisk.Play()"`);
        }
        break;
      }

      default:
        console.log(`Sound playback not supported on platform: ${platform}`);
    }
  } catch (error) {
    console.error('Failed to play sound:', error);
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
      await sendMacOSNotification(title, message, soundEnabled);
      break;

    case 'linux':
      await sendLinuxNotification(title, message);
      break;

    case 'win32':
      await sendWindowsNotification(title, message);
      break;

    default:
      console.log(`Notifications not supported on platform: ${platform}`);
  }
}

/**
 * NotificationService class - main interface for sending notifications
 */
export class NotificationService {
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
      console.log(`Notification suppressed (quiet hours): ${title}`);
      return { sent: false, reason: 'quiet_hours' };
    }

    // Check if push notifications are enabled
    if (!this.config.pushEnabled) {
      console.log(`Notification suppressed (disabled): ${title}`);
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

      console.log(`Notification sent: ${title}`);
      return { sent: true };
    } catch (error) {
      console.error(`Failed to send notification: ${title}`, error);
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
