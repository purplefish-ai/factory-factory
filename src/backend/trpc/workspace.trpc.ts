import { SessionProvider, WorkspaceProviderSelection } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import { getProviderUnavailableMessage } from '@/backend/lib/provider-cli-availability';
import {
  buildWorkspaceSessionSummaries,
  hasWorkingSessionSummary,
} from '@/backend/lib/session-summaries';
import { assembleWorkspaceDerivedState } from '@/backend/lib/workspace-derived-state';
import { DEFAULT_FOLLOWUP } from '@/backend/prompts/workflows';
import {
  computeKanbanColumn,
  computePendingRequestType,
  deriveWorkspaceFlowStateFromWorkspace,
} from '@/backend/services/workspace';
import type { SessionDeltaEvent } from '@/shared/acp-protocol';
import { KanbanColumn, WorkspaceStatus } from '@/shared/core';
import { autoIterationConfigSchema } from '@/shared/schemas/auto-iteration.schema';
import { findWorkspaceSessionRuntimeError } from '@/shared/session-runtime';
import { AttachmentSchema } from '@/shared/websocket';
import {
  buildWorkspaceNotificationMessageText,
  workspaceNotificationMessageId,
} from '@/shared/workspace-notifications';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';
import { toTRPCError } from './application-error-mapper';
import { type Context, publicProcedure, router, trustedLocalProcedure } from './trpc';
import { workspaceFilesRouter } from './workspace/files.trpc';
import { workspaceGitRouter } from './workspace/git.trpc';
import { workspaceIdeRouter } from './workspace/ide.trpc';
import { workspaceInitRouter } from './workspace/init.trpc';
import { workspaceRunScriptRouter } from './workspace/run-script.trpc';
import { getWorkspaceWithProjectOrThrow } from './workspace/workspace-helpers';

const loggerName = 'workspace-trpc';
const getLogger = (ctx: Context) => ctx.appContext.services.createLogger(loggerName);

function normalizeBulkArchiveError(error: unknown): TRPCError | undefined {
  if (error instanceof ApplicationError) {
    return toTRPCError(error);
  }
  return error instanceof TRPCError ? error : undefined;
}

// Zod schema for workspace creation source discriminated union
const workspaceCreationSourceSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('MANUAL'),
      projectId: z.string(),
      name: z.string().min(1),
      description: z.string().optional(),
      branchName: z.string().optional(),
      ratchetEnabled: z.boolean().optional(),
      initialPrompt: z.string().optional(),
      initialAttachments: z.array(AttachmentSchema).optional(),
      startupModePreset: z.enum(['non_interactive', 'plan']).optional(),
      provider: z.nativeEnum(SessionProvider).optional(),
      mode: z.enum(['STANDARD', 'AUTO_ITERATION']).optional(),
      autoIterationConfig: autoIterationConfigSchema.optional(),
    })
    .superRefine((data, ctx) => {
      if (data.mode === 'AUTO_ITERATION' && !data.autoIterationConfig) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'autoIterationConfig is required when mode is AUTO_ITERATION',
          path: ['autoIterationConfig'],
        });
      }
      if (data.autoIterationConfig && data.mode !== 'AUTO_ITERATION') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'autoIterationConfig is only allowed when mode is AUTO_ITERATION',
          path: ['autoIterationConfig'],
        });
      }
    }),
  z.object({
    type: z.literal('RESUME_BRANCH'),
    projectId: z.string(),
    branchName: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    ratchetEnabled: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('GITHUB_ISSUE'),
    projectId: z.string(),
    issueNumber: z.number(),
    issueUrl: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    ratchetEnabled: z.boolean().optional(),
    initialPrompt: z.string().optional(),
    startupModePreset: z.enum(['non_interactive', 'plan']).optional(),
    provider: z.nativeEnum(SessionProvider).optional(),
  }),
  z.object({
    type: z.literal('LINEAR_ISSUE'),
    projectId: z.string(),
    issueId: z.string(),
    issueIdentifier: z.string(),
    issueUrl: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    ratchetEnabled: z.boolean().optional(),
    initialPrompt: z.string().optional(),
    startupModePreset: z.enum(['non_interactive', 'plan']).optional(),
    provider: z.nativeEnum(SessionProvider).optional(),
  }),
]);

// =============================================================================
// Router
// =============================================================================

export const workspaceRouter = router({
  // List workspaces for a project
  list: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        status: z.nativeEnum(WorkspaceStatus).optional(),
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
      })
    )
    .query(({ ctx, input }) => {
      const { projectId, ...filters } = input;
      return ctx.appContext.services.workspaceDataService.findByProjectId(projectId, filters);
    }),

  // Get unified project summary state for sidebar (workspaces + working status + git stats + review count)
  getProjectSummaryState: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ ctx, input }) =>
      ctx.appContext.services.workspaceQueryService.getProjectSummaryState(input.projectId)
    ),

  // List workspaces with kanban state (for board view)
  listWithKanbanState: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        status: z.nativeEnum(WorkspaceStatus).optional(),
        kanbanColumn: z.nativeEnum(KanbanColumn).optional(),
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
      })
    )
    .query(({ ctx, input }) =>
      ctx.appContext.services.workspaceQueryService.listWithKanbanState(input)
    ),

  // List workspaces with runtime state (for table view)
  listWithRuntimeState: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        status: z.nativeEnum(WorkspaceStatus).optional(),
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
      })
    )
    .query(({ ctx, input }) =>
      ctx.appContext.services.workspaceQueryService.listWithRuntimeState(input)
    ),

  // Get workspace by ID
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const { sessionDomainService, sessionService, workspaceDataService } = ctx.appContext.services;
    const workspace = await workspaceDataService.findById(input.id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${input.id}`);
    }
    const flowState = deriveWorkspaceFlowStateFromWorkspace(workspace);
    const sessionSummaries = buildWorkspaceSessionSummaries(workspace.agentSessions ?? [], (id) =>
      sessionService.getRuntimeSnapshot(id)
    );
    const sessionIds = workspace.agentSessions?.map((session) => session.id) ?? [];
    const pendingRequestType = computePendingRequestType(
      sessionIds,
      sessionDomainService.getAllPendingRequests()
    );
    const derivedState = assembleWorkspaceDerivedState(
      {
        lifecycle: workspace.status,
        prUrl: workspace.prUrl,
        prState: workspace.prState,
        prCiStatus: workspace.prCiStatus,
        ratchetState: workspace.ratchetState,
        hasHadSessions: workspace.hasHadSessions,
        sessionIsWorking: hasWorkingSessionSummary(sessionSummaries),
        pendingRequestType,
        hasSessionRuntimeError: Boolean(findWorkspaceSessionRuntimeError(sessionSummaries)),
        runScriptStatus: workspace.runScriptStatus,
        flowState,
      },
      {
        computeKanbanColumn,
        deriveSidebarStatus: deriveWorkspaceSidebarStatus,
      }
    );
    return {
      ...workspace,
      sessionSummaries,
      sidebarStatus: derivedState.sidebarStatus,
      ratchetButtonAnimated: derivedState.ratchetButtonAnimated,
      flowPhase: derivedState.flowPhase,
      ciObservation: derivedState.ciObservation,
      statusReason: derivedState.statusReason,
      pendingRequestType,
    };
  }),

  // Create a new workspace
  create: trustedLocalProcedure
    .input(workspaceCreationSourceSchema)
    .mutation(async ({ ctx, input }) => {
      const logger = getLogger(ctx);
      const {
        configService,
        createWorkspaceCreationService,
        initializeWorkspaceWorktree,
        sessionDataService,
        sessionProviderResolverService,
      } = ctx.appContext.services;
      const maxSessionsPerWorkspace = configService.getMaxSessionsPerWorkspace();
      const explicitProvider =
        input.type === 'MANUAL' || input.type === 'GITHUB_ISSUE' || input.type === 'LINEAR_ISSUE'
          ? input.provider
          : undefined;
      let defaultSessionProvider: SessionProvider | undefined;

      // Workspace creation provisions a default session when session capacity is enabled.
      // Block creation if the effective provider cannot be used on this machine.
      if (maxSessionsPerWorkspace > 0) {
        defaultSessionProvider =
          await sessionProviderResolverService.resolveProviderForWorkspaceCreation(
            explicitProvider
          );
        const cliHealth = await ctx.appContext.services.cliHealthService.checkHealth();
        const providerUnavailableMessage = getProviderUnavailableMessage(
          defaultSessionProvider,
          cliHealth
        );
        if (providerUnavailableMessage) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `Cannot create workspace: ${providerUnavailableMessage}`,
          });
        }
      }

      // Use the canonical workspace creation service
      const workspaceCreationService = createWorkspaceCreationService({
        logger,
      });

      const workspace = await workspaceCreationService.create(input);

      if (maxSessionsPerWorkspace > 0 && defaultSessionProvider) {
        try {
          await sessionDataService.createAgentSession({
            workspaceId: workspace.id,
            workflow: DEFAULT_FOLLOWUP,
            name: 'Chat 1',
            provider: defaultSessionProvider,
            providerProjectPath: null,
          });
        } catch (error) {
          logger.warn('Failed to create default session for workspace', {
            workspaceId: workspace.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const branchName =
        input.type === 'MANUAL'
          ? input.branchName
          : input.type === 'RESUME_BRANCH'
            ? input.branchName
            : undefined;
      const useExistingBranch = input.type === 'RESUME_BRANCH';

      void initializeWorkspaceWorktree(workspace.id, {
        branchName,
        useExistingBranch,
      }).catch((error) => {
        const initError = error instanceof Error ? error : new Error(String(error));
        logger.error('Unexpected error during background workspace initialization', initError, {
          workspaceId: workspace.id,
        });
      });

      return workspace;
    }),

  // Rename a workspace
  rename: publicProcedure
    .input(z.object({ id: z.string(), name: z.string().trim().min(1).max(255) }))
    .mutation(async ({ ctx, input }) => {
      const { workspaceDataService } = ctx.appContext.services;
      const workspace = await workspaceDataService.findById(input.id);
      if (!workspace) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Workspace not found: ${input.id}` });
      }
      return workspaceDataService.rename(input.id, input.name);
    }),

  // Manually associate a GitHub PR URL with a workspace
  attachPR: publicProcedure
    .input(
      z.object({
        id: z.string(),
        prUrl: z
          .string()
          .trim()
          .regex(
            /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/,
            'Must be a valid GitHub PR URL (https://github.com/owner/repo/pull/N)'
          ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { prSnapshotService, workspaceDataService } = ctx.appContext.services;
      const workspace = await workspaceDataService.findById(input.id);
      if (!workspace) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Workspace not found: ${input.id}` });
      }
      const result = await prSnapshotService.attachAndRefreshPR(input.id, input.prUrl);
      if (!result.success) {
        if (result.reason === 'workspace_not_found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: `Workspace not found: ${input.id}` });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message:
            result.reason === 'fetch_failed'
              ? `PR was associated but snapshot fetch failed for: ${input.prUrl}`
              : `Failed to attach PR: ${input.prUrl}`,
        });
      }
      const updatedWorkspace = await workspaceDataService.findById(input.id);
      if (!updatedWorkspace) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Workspace not found: ${input.id}` });
      }
      return updatedWorkspace;
    }),

  // Toggle workspace-level ratcheting
  toggleRatcheting: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        enabled: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const logger = getLogger(ctx);
      const { ratchetService, workspaceDataService } = ctx.appContext.services;
      await ratchetService.setWorkspaceRatcheting(input.workspaceId, input.enabled);
      const updatedWorkspace = await workspaceDataService.findById(input.workspaceId);
      if (!updatedWorkspace) {
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      }

      // Do not block the toggle response on external GitHub checks.
      // Run an immediate ratchet check in the background.
      if (input.enabled) {
        void ratchetService.checkWorkspaceById(input.workspaceId).catch((error) => {
          logger.warn('Background ratchet check failed after enabling workspace ratcheting', {
            workspaceId: input.workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }

      return updatedWorkspace;
    }),

  // Update workspace provider defaults (session + ratchet).
  updateProviderDefaults: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        defaultSessionProvider: z.nativeEnum(WorkspaceProviderSelection).optional(),
        ratchetSessionProvider: z.nativeEnum(WorkspaceProviderSelection).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const updated = await ctx.appContext.services.workspaceDataService.update(input.workspaceId, {
        defaultSessionProvider: input.defaultSessionProvider,
        ratchetSessionProvider: input.ratchetSessionProvider,
      });
      return updated;
    }),

  // Archive a workspace
  archive: publicProcedure
    .input(z.object({ id: z.string(), commitUncommitted: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { archiveWorkspace, workspaceDataService } = ctx.appContext.services;
      const workspace = await getWorkspaceWithProjectOrThrow(workspaceDataService, input.id);
      return archiveWorkspace(
        workspace,
        {
          commitUncommitted: input.commitUncommitted ?? true,
        },
        ctx.appContext.services
      );
    }),

  // Bulk archive workspaces in a specific kanban column
  bulkArchive: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        kanbanColumn: z.nativeEnum(KanbanColumn),
        commitUncommitted: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const logger = getLogger(ctx);
      const { archiveWorkspace, workspaceDataService, workspaceQueryService } =
        ctx.appContext.services;
      const { projectId, kanbanColumn, commitUncommitted = true } = input;

      // Get all workspaces in the specified kanban column
      const workspacesWithState = await workspaceQueryService.listWithKanbanState({
        projectId,
        kanbanColumn,
      });

      logger.info('Bulk archiving workspaces', {
        projectId,
        kanbanColumn,
        count: workspacesWithState.length,
      });

      // Archive each workspace sequentially
      const results = [];
      for (const workspaceWithState of workspacesWithState) {
        try {
          const workspace = await getWorkspaceWithProjectOrThrow(
            workspaceDataService,
            workspaceWithState.id
          );
          await archiveWorkspace(workspace, { commitUncommitted }, ctx.appContext.services);
          results.push({ id: workspace.id, success: true });
        } catch (error) {
          const mappedError = normalizeBulkArchiveError(error);
          logger.error('Failed to archive workspace during bulk operation', {
            workspaceId: workspaceWithState.id,
            error: error instanceof Error ? error.message : String(error),
          });
          results.push({
            id: workspaceWithState.id,
            success: false,
            error: error instanceof Error ? error.message : String(error),
            code: mappedError?.code ?? 'INTERNAL_SERVER_ERROR',
          });
        }
      }

      return { results, total: workspacesWithState.length };
    }),

  // Delete a workspace
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const { cleanupWorkspaceRuntimeResources, workspaceDataService } = ctx.appContext.services;
    // Clean up running sessions, terminals, and dev processes before deleting
    await cleanupWorkspaceRuntimeResources(input.id, ctx.appContext.services, 'delete');
    ctx.appContext.services.runScriptService.evictWorkspaceBuffers(input.id);
    const result = await workspaceDataService.delete(input.id);
    ctx.appContext.services.cleanupWorkspaceScopedCaches(input.id);
    return result;
  }),

  // Refresh factory-factory.json configuration for all workspaces
  refreshFactoryConfigs: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.appContext.services.runScriptConfigPersistenceService.refreshFactoryConfigs(
        input.projectId
      )
    ),

  // Get factory-factory.json configuration for a project
  getFactoryConfig: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ ctx, input }) =>
      ctx.appContext.services.runScriptConfigPersistenceService.getFactoryConfig(input.projectId)
    ),

  // Sync PR status for a workspace (immediate refresh from GitHub)
  syncPRStatus: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { fireLifecycleNotification, workspaceQueryService } = ctx.appContext.services;
      const result = await workspaceQueryService.syncPRStatus(input.workspaceId);
      if (result.success && result.prState && result.previousPrState !== result.prState) {
        const { prState } = result;
        if (prState === 'OPEN' && result.previousPrState === 'NONE') {
          fireLifecycleNotification(input.workspaceId, 'A pull request has been opened.').catch(
            () => undefined
          );
        } else if (prState === 'MERGED') {
          fireLifecycleNotification(input.workspaceId, 'The pull request has been merged.').catch(
            () => undefined
          );
        }
      }
      return result;
    }),

  // Sync PR status for all workspaces in a project (immediate refresh from GitHub)
  syncAllPRStatuses: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.appContext.services.workspaceQueryService.syncAllPRStatuses(input.projectId)
    ),

  // Check if workspace branch has changes relative to the project's default branch
  hasChanges: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(({ ctx, input }) =>
      ctx.appContext.services.workspaceQueryService.hasChanges(input.workspaceId)
    ),

  // -------------------------------------------------------------------------
  // Child workspace procedures
  // -------------------------------------------------------------------------

  // Create a child workspace under a parent, optionally in a different project
  createChild: trustedLocalProcedure
    .input(
      z.object({
        parentWorkspaceId: z.string(),
        projectId: z.string(),
        name: z.string().min(1),
        description: z.string().optional(),
        initialPrompt: z.string().optional(),
        reportBackOn: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const workspaceId = await ctx.appContext.services.createChildWorkspace(input);
      return { workspaceId };
    }),

  // List non-archived children of a workspace with status summaries
  listChildren: publicProcedure
    .input(z.object({ parentWorkspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { workspaceRelationshipsService } = ctx.appContext.services;
      const children = await workspaceRelationshipsService.findChildrenWithStatus(
        input.parentWorkspaceId
      );
      return children.map((child) => ({
        id: child.id,
        name: child.name,
        description: child.description,
        status: child.status,
        prState: child.prState,
        prUrl: child.prUrl,
        cachedKanbanColumn: child.cachedKanbanColumn,
        projectId: child.projectId,
        projectName: child.project.name,
        projectSlug: child.project.slug,
        createdAt: child.createdAt,
      }));
    }),

  // Get the parent workspace summary for a child workspace
  getParent: publicProcedure
    .input(z.object({ childWorkspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { workspaceRelationshipsService } = ctx.appContext.services;
      const parent = await workspaceRelationshipsService.findParent(input.childWorkspaceId);
      if (!parent) {
        return null;
      }
      return {
        id: parent.id,
        name: parent.name,
        projectId: parent.projectId,
        projectName: parent.project.name,
        projectSlug: parent.project.slug,
      };
    }),

  // Send a message from a child workspace to the parent's active session (or queue it)
  sendMessageToParent: publicProcedure
    .input(
      z.object({
        childWorkspaceId: z.string(),
        message: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const {
        chatMessageHandlerService,
        persistChildNotification,
        sessionDataService,
        sessionDomainService,
        workspaceDataService,
      } = ctx.appContext.services;
      const child = await workspaceDataService.findByIdWithProject(input.childWorkspaceId);
      if (!child) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Workspace not found: ${input.childWorkspaceId}`,
        });
      }
      if (!child.parentWorkspaceId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This workspace has no parent',
        });
      }

      const parentWorkspaceId = child.parentWorkspaceId;

      // Persist first so the message survives if live delivery races a dying
      // session; successful dispatch marks the row delivered.
      const notification = await persistChildNotification({
        parentWorkspaceId,
        sourceWorkspaceId: input.childWorkspaceId,
        message: input.message,
      });
      if (!notification) {
        return { delivered: false };
      }

      // Try to find an active/idle session on the parent workspace to inject into.
      // Use the most recently created active session so we target the current one.
      const parentSessions =
        await sessionDataService.findAgentSessionsByWorkspaceId(parentWorkspaceId);
      const activeSession = [...parentSessions]
        .reverse()
        .find((s) => s.status === 'RUNNING' || s.status === 'IDLE');

      if (!activeSession) {
        return { delivered: false };
      }

      // Session startup delivery may have already queued this notification
      // (persist above races deliverPendingChildNotifications on a starting session).
      const messageId = workspaceNotificationMessageId(notification.id);
      if (sessionDomainService.hasQueuedMessage(activeSession.id, messageId)) {
        return { delivered: true };
      }

      // Enqueue as a user message so the parent agent acts on it
      const enqueueResult = sessionDomainService.enqueue(activeSession.id, {
        id: messageId,
        text: buildWorkspaceNotificationMessageText(notification),
        timestamp: new Date().toISOString(),
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      });
      if ('error' in enqueueResult) {
        // Leave the notification pending; it is delivered at next session start.
        getLogger(ctx).warn('sendMessageToParent: live enqueue failed, left pending', {
          notificationId: notification.id,
          sessionId: activeSession.id,
          error: enqueueResult.error,
        });
        return { delivered: false };
      }

      // Show notification card in parent's UI
      const claudeMessage = {
        type: 'child_workspace_update' as const,
        childWorkspaceId: input.childWorkspaceId,
        childWorkspaceName: child.name,
        childProjectName: child.project.name,
        text: input.message,
        timestamp: new Date().toISOString(),
      };
      const order = sessionDomainService.appendClaudeEvent(activeSession.id, claudeMessage);
      sessionDomainService.emitDelta(activeSession.id, {
        type: 'agent_message',
        data: claudeMessage,
        order,
      } as SessionDeltaEvent & { order: number });
      await chatMessageHandlerService.tryDispatchNextMessage(activeSession.id);

      return { delivered: true };
    }),

  // Send a message from a parent workspace to a child's active session (or queue it)
  sendMessageToChild: publicProcedure
    .input(
      z.object({
        parentWorkspaceId: z.string(),
        childWorkspaceId: z.string(),
        message: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const {
        chatMessageHandlerService,
        persistParentNotification,
        sessionDataService,
        sessionDomainService,
        workspaceDataService,
      } = ctx.appContext.services;
      const child = await workspaceDataService.findByIdWithProject(input.childWorkspaceId);
      if (!child) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Workspace not found: ${input.childWorkspaceId}`,
        });
      }
      if (child.parentWorkspaceId !== input.parentWorkspaceId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'The specified child workspace does not belong to this parent',
        });
      }

      const parent = await workspaceDataService.findByIdWithProject(input.parentWorkspaceId);

      // Persist first so the message survives if live delivery races a dying
      // session; successful dispatch marks the row delivered.
      const notification = await persistParentNotification({
        parentWorkspaceId: input.parentWorkspaceId,
        targetChildWorkspaceId: input.childWorkspaceId,
        message: input.message,
      });
      if (!notification) {
        return { delivered: false };
      }

      const childSessions = await sessionDataService.findAgentSessionsByWorkspaceId(
        input.childWorkspaceId
      );
      const activeSession = [...childSessions]
        .reverse()
        .find((s) => s.status === 'RUNNING' || s.status === 'IDLE');

      if (!activeSession) {
        return { delivered: false };
      }

      // Session startup delivery may have already queued this notification
      // (persist above races deliverPendingChildNotifications on a starting session).
      const messageId = workspaceNotificationMessageId(notification.id);
      if (sessionDomainService.hasQueuedMessage(activeSession.id, messageId)) {
        return { delivered: true };
      }

      // Enqueue as a user message so the child agent acts on it
      const enqueueResult = sessionDomainService.enqueue(activeSession.id, {
        id: messageId,
        text: buildWorkspaceNotificationMessageText(notification),
        timestamp: new Date().toISOString(),
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      });
      if ('error' in enqueueResult) {
        // Leave the notification pending; it is delivered at next session start.
        getLogger(ctx).warn('sendMessageToChild: live enqueue failed, left pending', {
          notificationId: notification.id,
          sessionId: activeSession.id,
          error: enqueueResult.error,
        });
        return { delivered: false };
      }

      // Show notification card in child's UI
      const claudeMessage = {
        type: 'parent_workspace_update' as const,
        parentWorkspaceId: input.parentWorkspaceId,
        parentWorkspaceName: parent?.name,
        parentProjectName: parent?.project.name,
        text: input.message,
        timestamp: new Date().toISOString(),
      };
      const order = sessionDomainService.appendClaudeEvent(activeSession.id, claudeMessage);
      sessionDomainService.emitDelta(activeSession.id, {
        type: 'agent_message',
        data: claudeMessage,
        order,
      } as SessionDeltaEvent & { order: number });
      await chatMessageHandlerService.tryDispatchNextMessage(activeSession.id);

      return { delivered: true };
    }),

  // Archive a child workspace on behalf of the parent
  archiveChild: publicProcedure
    .input(
      z.object({
        parentWorkspaceId: z.string(),
        childWorkspaceId: z.string(),
        commitUncommitted: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { archiveWorkspace, workspaceDataService } = ctx.appContext.services;
      const child = await workspaceDataService.findByIdWithProject(input.childWorkspaceId);
      if (!child) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Workspace not found: ${input.childWorkspaceId}`,
        });
      }
      if (child.parentWorkspaceId !== input.parentWorkspaceId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'The specified child workspace does not belong to this parent',
        });
      }
      return archiveWorkspace(
        child,
        { commitUncommitted: input.commitUncommitted ?? true },
        ctx.appContext.services
      );
    }),

  // Get count of undelivered notifications for a workspace
  getPendingNotificationCount: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(({ ctx, input }) =>
      ctx.appContext.services.workspaceNotificationService.countPending(input.workspaceId)
    ),

  // Merge sub-routers
  ...workspaceFilesRouter._def.procedures,
  ...workspaceGitRouter._def.procedures,
  ...workspaceIdeRouter._def.procedures,
  ...workspaceInitRouter._def.procedures,
  ...workspaceRunScriptRouter._def.procedures,
});
