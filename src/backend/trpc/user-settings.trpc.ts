/**
 * UserSettings tRPC Router
 *
 * Provides operations for managing user settings (IDE preferences, etc).
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { execCommand } from '../lib/shell';
import { userSettingsAccessor } from '../resource_accessors/index';
import { configService, createLogger } from '../services/index';
import { publicProcedure, router } from './trpc';

const logger = createLogger('user-settings-trpc');

const MAX_SOUND_FILE_SIZE = 1024 * 1024; // 1MB
const ALLOWED_MIME_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp3'] as const;
const MIME_TO_EXTENSION: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
};

export const userSettingsRouter = router({
  /**
   * Get user settings
   */
  get: publicProcedure.query(async () => {
    return await userSettingsAccessor.get();
  }),

  /**
   * Update user settings
   */
  update: publicProcedure
    .input(
      z.object({
        preferredIde: z.enum(['cursor', 'vscode', 'custom']).optional(),
        customIdeCommand: z
          .string()
          .min(1, 'Command cannot be empty')
          .refine(
            (cmd) => cmd.includes('{workspace}'),
            'Command must include {workspace} placeholder'
          )
          .refine(
            (cmd) => !/[;&|`$()[\]]/.test(cmd),
            'Command contains invalid shell metacharacters'
          )
          .nullable()
          .optional(),
        playSoundOnComplete: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Additional validation: if preferredIde is custom, customIdeCommand must be provided
      if (input.preferredIde === 'custom' && !input.customIdeCommand) {
        throw new Error('Custom IDE command is required when using custom IDE');
      }
      return await userSettingsAccessor.update(input);
    }),

  /**
   * Test custom IDE command
   */
  testCustomCommand: publicProcedure
    .input(
      z.object({
        customCommand: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      // Validate command format
      if (!input.customCommand.includes('{workspace}')) {
        throw new Error('Command must include {workspace} placeholder');
      }

      if (/[;&|`$()[\]]/.test(input.customCommand)) {
        throw new Error('Command contains invalid shell metacharacters');
      }

      // Test with a safe test path (current directory)
      const testPath = process.cwd();
      // Always escape for consistent parsing/unescaping
      const escapedPath = testPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const quotedPath = testPath.includes(' ') ? `"${escapedPath}"` : escapedPath;
      const command = input.customCommand.replace(/\{workspace\}/g, quotedPath);

      const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      // Strip quotes then unescape backslashes that were escaped for parsing
      const cmd = parts[0]?.replace(/"/g, '').replace(/\\\\/g, '\\');
      const args = parts.slice(1).map((arg) => arg.replace(/"/g, '').replace(/\\\\/g, '\\'));

      if (!cmd) {
        throw new Error('Invalid command format');
      }

      try {
        await execCommand(cmd, args);
        return { success: true, message: 'Command executed successfully' };
      } catch (error) {
        throw new Error(
          `Command failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }),

  /**
   * Upload a custom notification sound
   */
  uploadNotificationSound: publicProcedure
    .input(
      z.object({
        fileName: z.string().min(1),
        fileData: z.string(), // base64 encoded
        mimeType: z.enum(ALLOWED_MIME_TYPES),
      })
    )
    .mutation(async ({ input }) => {
      const { fileName, fileData, mimeType } = input;

      // Decode base64 and validate size
      const buffer = Buffer.from(fileData, 'base64');
      if (buffer.length > MAX_SOUND_FILE_SIZE) {
        throw new Error(`File size exceeds maximum of ${MAX_SOUND_FILE_SIZE / 1024}KB`);
      }

      // Ensure uploads directory exists
      const uploadsDir = configService.getUploadsDir();
      if (!existsSync(uploadsDir)) {
        mkdirSync(uploadsDir, { recursive: true });
      }

      // Generate unique filename
      const extension = MIME_TO_EXTENSION[mimeType] || extname(fileName) || '.mp3';
      const safeBaseName = basename(fileName, extname(fileName))
        .replace(/[^a-zA-Z0-9-_]/g, '_')
        .slice(0, 50);
      const uniqueFileName = `notification-sound-${Date.now()}-${safeBaseName}${extension}`;
      const filePath = join(uploadsDir, uniqueFileName);

      // Get current settings to check for existing custom sound
      const currentSettings = await userSettingsAccessor.get();
      const oldSoundPath = currentSettings.notificationSoundPath;

      // Delete old custom sound file if it exists
      if (oldSoundPath) {
        const oldFullPath = join(uploadsDir, oldSoundPath);
        if (existsSync(oldFullPath)) {
          try {
            unlinkSync(oldFullPath);
            logger.info('Deleted old notification sound', { path: oldFullPath });
          } catch (err) {
            logger.warn('Failed to delete old notification sound', {
              path: oldFullPath,
              error: err,
            });
          }
        }
      }

      // Write new file
      writeFileSync(filePath, buffer);
      logger.info('Saved notification sound', { path: filePath, size: buffer.length });

      // Update user settings with new sound path
      await userSettingsAccessor.update({ notificationSoundPath: uniqueFileName });

      return {
        success: true,
        fileName: uniqueFileName,
        url: `/uploads/${uniqueFileName}`,
      };
    }),

  /**
   * Delete custom notification sound and reset to default
   */
  deleteNotificationSound: publicProcedure.mutation(async () => {
    const currentSettings = await userSettingsAccessor.get();
    const soundPath = currentSettings.notificationSoundPath;

    if (soundPath) {
      const uploadsDir = configService.getUploadsDir();
      const fullPath = join(uploadsDir, soundPath);

      if (existsSync(fullPath)) {
        try {
          unlinkSync(fullPath);
          logger.info('Deleted notification sound', { path: fullPath });
        } catch (err) {
          logger.warn('Failed to delete notification sound file', { path: fullPath, error: err });
        }
      }
    }

    // Clear the sound path in settings
    await userSettingsAccessor.update({ notificationSoundPath: null });

    return { success: true };
  }),

  /**
   * Get the URL for the notification sound (custom or default)
   */
  getNotificationSoundUrl: publicProcedure.query(async () => {
    const settings = await userSettingsAccessor.get();

    if (settings.notificationSoundPath) {
      return {
        isCustom: true,
        url: `/uploads/${settings.notificationSoundPath}`,
        fileName: settings.notificationSoundPath,
      };
    }

    return {
      isCustom: false,
      url: '/sounds/workspace-complete.mp3',
      fileName: null,
    };
  }),
});
