/**
 * UserSettings tRPC Router
 *
 * Provides operations for managing user settings (IDE preferences, etc).
 */

import {
  RatchetReviewTriggerMode,
  SessionPermissionPreset,
  SessionProvider,
} from '@prisma-gen/client';
import { z } from 'zod';
import type { ApplicationServices } from '@/backend/app-context';
import { execCommand } from '@/backend/lib/shell';
import { publicProcedure, router } from './trpc';

const providerModelOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().nullable().optional(),
});

const providerEffortOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().nullable().optional(),
});

type ProviderOptions = {
  models: z.infer<typeof providerModelOptionSchema>[];
  efforts: z.infer<typeof providerEffortOptionSchema>[];
  source: 'cli' | 'fallback';
  error?: string;
};

const CLAUDE_FALLBACK_OPTIONS: ProviderOptions = {
  source: 'fallback',
  models: [
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
    { value: 'haiku', label: 'Haiku' },
    { value: 'fable', label: 'Fable' },
  ],
  efforts: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ],
};

function formatEffortLabel(value: string): string {
  return value
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

async function getCodexProviderOptions(
  fetchCodexModelCatalogFromAppServer: ApplicationServices['fetchCodexModelCatalogFromAppServer']
): Promise<ProviderOptions> {
  try {
    const catalog = await fetchCodexModelCatalogFromAppServer();
    const effortsByValue = new Map<string, string | null>();
    for (const model of catalog) {
      for (const effort of model.supportedReasoningEfforts ?? []) {
        if (!effortsByValue.has(effort.reasoningEffort)) {
          effortsByValue.set(effort.reasoningEffort, effort.description ?? null);
        }
      }
    }

    return {
      source: 'cli',
      models: catalog.map((model) => ({
        value: model.id,
        label: model.displayName || model.id,
        description: model.description ?? null,
      })),
      efforts: Array.from(effortsByValue.entries()).map(([value, description]) => ({
        value,
        label: formatEffortLabel(value),
        ...(description ? { description } : {}),
      })),
    };
  } catch (error) {
    return {
      source: 'fallback',
      error: error instanceof Error ? error.message : String(error),
      models: [
        { value: 'default', label: 'Default' },
        { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
      ],
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ],
    };
  }
}

export const userSettingsRouter = router({
  /**
   * Get user settings
   */
  get: publicProcedure.query(async ({ ctx }) => {
    return await ctx.appContext.services.userSettingsQueryService.get();
  }),

  getProviderOptions: publicProcedure.query(async ({ ctx }) => {
    const codex = await getCodexProviderOptions(
      ctx.appContext.services.fetchCodexModelCatalogFromAppServer
    );
    return {
      CLAUDE: CLAUDE_FALLBACK_OPTIONS,
      CODEX: codex,
    };
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
        ratchetReplyToPrComments: z.boolean().optional(),
        ratchetReviewTriggerMode: z.nativeEnum(RatchetReviewTriggerMode).optional(),
        // Session provider defaults
        defaultSessionProvider: z.nativeEnum(SessionProvider).optional(),
        defaultClaudeModel: z.string().trim().min(1, 'Claude model cannot be empty').optional(),
        defaultCodexModel: z.string().trim().min(1, 'Codex model cannot be empty').optional(),
        defaultClaudeReasoningEffort: z.string().trim().min(1).nullable().optional(),
        defaultCodexReasoningEffort: z.string().trim().min(1).nullable().optional(),
        // Permission preset defaults
        defaultWorkspacePermissions: z.nativeEnum(SessionPermissionPreset).optional(),
        ratchetPermissions: z.nativeEnum(SessionPermissionPreset).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Additional validation: if preferredIde is custom, customIdeCommand must be provided
      if (input.preferredIde === 'custom' && !input.customIdeCommand) {
        throw new Error('Custom IDE command is required when using custom IDE');
      }
      return await ctx.appContext.services.userSettingsQueryService.update(input);
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
    .query(async ({ ctx, input }) => {
      return await ctx.appContext.services.userSettingsQueryService.getWorkspaceOrder(
        input.projectId
      );
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
    .mutation(async ({ ctx, input }) => {
      await ctx.appContext.services.userSettingsQueryService.updateWorkspaceOrder(
        input.projectId,
        input.workspaceIds
      );
      return { success: true };
    }),
});
