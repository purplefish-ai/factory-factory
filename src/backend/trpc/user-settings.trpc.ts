/**
 * UserSettings tRPC Router
 *
 * Provides operations for managing user settings (IDE preferences, etc).
 */

import { z } from 'zod';
import { execCommand } from '../lib/shell';
import { userSettingsAccessor } from '../resource_accessors/index';
import { publicProcedure, router } from './trpc';

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
        notificationSoundPath: z.string().nullable().optional(),
        // Ratchet settings
        ratchetEnabled: z.boolean().optional(),
        ratchetAutoFixCi: z.boolean().optional(),
        ratchetAutoFixReviews: z.boolean().optional(),
        ratchetAutoMerge: z.boolean().optional(),
        ratchetAllowedReviewers: z.array(z.string()).nullable().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Additional validation: if preferredIde is custom, customIdeCommand must be provided
      if (input.preferredIde === 'custom' && !input.customIdeCommand) {
        throw new Error('Custom IDE command is required when using custom IDE');
      }
      // Transform JSON array fields to match Prisma Json type
      const { ratchetAllowedReviewers, ...rest } = input;
      return await userSettingsAccessor.update({
        ...rest,
        ratchetAllowedReviewers:
          ratchetAllowedReviewers === null
            ? { set: null }
            : ratchetAllowedReviewers !== undefined
              ? ratchetAllowedReviewers
              : undefined,
      });
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
   * Get workspace order for a project
   */
  getWorkspaceOrder: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      return await userSettingsAccessor.getWorkspaceOrder(input.projectId);
    }),

  /**
   * Update workspace order for a project
   */
  updateWorkspaceOrder: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        workspaceIds: z.array(z.string()),
      })
    )
    .mutation(async ({ input }) => {
      await userSettingsAccessor.updateWorkspaceOrder(input.projectId, input.workspaceIds);
      return { success: true };
    }),
});
