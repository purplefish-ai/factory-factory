import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { workspaceDataService } from '@/backend/domains/workspace';
import { checkIdeAvailable, openPathInIde } from '@/backend/lib/ide-helpers';
import { userSettingsQueryService } from '@/backend/services/user-settings-query.service';
import { publicProcedure, router } from '@/backend/trpc/trpc';

export const workspaceIdeRouter = router({
  // Get list of available IDEs
  getAvailableIdes: publicProcedure.query(async () => {
    const ides: Array<{ id: string; name: string }> = [];
    const settings = await userSettingsQueryService.get();

    // Check Cursor
    const cursorAvailable = await checkIdeAvailable('cursor');
    if (cursorAvailable) {
      ides.push({ id: 'cursor', name: 'Cursor' });
    }

    // Check VS Code
    const vscodeAvailable = await checkIdeAvailable('vscode');
    if (vscodeAvailable) {
      ides.push({ id: 'vscode', name: 'VS Code' });
    }

    // Add custom IDE if configured
    if (settings.preferredIde === 'custom' && settings.customIdeCommand) {
      ides.push({ id: 'custom', name: 'Custom IDE' });
    }

    return { ides, preferredIde: settings.preferredIde };
  }),

  // Open workspace in specified IDE
  openInIde: publicProcedure
    .input(z.object({ id: z.string(), ide: z.string().optional() }))
    .mutation(async ({ input }) => {
      const workspace = await workspaceDataService.findById(input.id);
      if (!workspace) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Workspace not found: ${input.id}`,
        });
      }

      if (!workspace.worktreePath) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Workspace has no worktree path',
        });
      }

      // Get user settings to determine which IDE to use
      const settings = await userSettingsQueryService.get();
      const ideToUse = input.ide ?? settings.preferredIde;

      // Validate custom IDE configuration
      if (ideToUse === 'custom' && !settings.customIdeCommand) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'Custom IDE selected but no command configured. Please configure in Admin settings.',
        });
      }

      const opened = await openPathInIde(
        ideToUse,
        workspace.worktreePath,
        settings.customIdeCommand
      );
      if (!opened) {
        const errorMessage =
          ideToUse === 'custom'
            ? `Failed to open custom IDE. Check your command configuration in Admin settings.`
            : `Failed to open ${ideToUse}. Make sure it is installed and configured correctly.`;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: errorMessage,
        });
      }

      return { success: true };
    }),
});
