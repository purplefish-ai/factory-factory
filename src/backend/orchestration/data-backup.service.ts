/**
 * Data Backup Service
 *
 * Handles export and import of database data for backup/restore purposes.
 * Used when database migrations require a reset.
 */
import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import { nullablePrismaJson } from '@/backend/lib/prisma-json';
import {
  restoreAgentConfigRecovery,
  restoreAgentHistoryRecovery,
} from '@/backend/services/agent-definition';
import {
  restoreCodexAccountMetadata,
  resolveRestoredCodexAccountId as restoredAccountId,
} from '@/backend/services/codex-accounts';
import { restoreRecoveryDecisions } from '@/backend/services/decision-log';
import { createLogger } from '@/backend/services/logger.service';
import { restorePeriodicRecovery } from '@/backend/services/periodic-task';
import {
  exportSessionArchives,
  restoreSessionArchives,
  publishRestoredSessionArchives,
  restoreRetainedSessionRecovery,
} from '@/backend/services/session';
import {
  type DataBackupTransactionClient,
  dataBackupAccessor,
  type WorkspaceForExport,
} from '@/backend/services/settings/resources/data-backup.accessor';
import {
  restoreRecoveryNotifications,
  restoreRetainedWorkspaceRecovery,
  restoreWorkspaceScheduleLinks,
  workspacePrSnapshotService,
  workspaceChildHistoryService,
} from '@/backend/services/workspace';
import { normalizeColorScheme } from '@/shared/appearance';
import { assertRecoveryWireBudget } from '@/shared/recovery-wire-budget';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import type {
  ExportData,
  exportedAgentSessionSchema,
  exportedProjectSchema,
  exportedTerminalSessionSchema,
  exportedUserSettingsSchema,
  exportedWorkspaceSchema,
} from '@/shared/schemas/export-data.schema';
import { sanitizeIssueTrackerConfig } from '@/shared/schemas/issue-tracker-config.schema';
import {
  recoveryJsonNullLookup,
  type RecoveryJsonNullLookup,
} from '@/shared/schemas/recovery-json-storage.schema';
import { selectRecoveryGraph } from './data-backup-graph';
import { recoveryManifest, validateRecoveryManifest } from './data-backup-manifest';
import { exportPRBackupState, restorePRBackupState } from './data-backup-pr-events';

type TransactionClient = DataBackupTransactionClient;

const logger = createLogger('data-backup');
const recoveryJsonSchema = z.json();
function validateWireBudget(value: unknown): void {
  try {
    assertRecoveryWireBudget(value);
  } catch (cause) {
    throw new ApplicationError(
      'INVALID_INPUT',
      cause instanceof Error ? cause.message : 'Invalid recovery package size',
      { cause }
    );
  }
}

// ============================================================================
// Types
// ============================================================================

export interface ImportCounter {
  imported: number;
  skipped: number;
}

export interface ImportResults {
  projects: ImportCounter;
  workspaces: ImportCounter;
  agentSessions: ImportCounter;
  terminalSessions: ImportCounter;
  userSettings: { imported: boolean; skipped: boolean };
}

// Internal types extracted from schemas (using explicit exports instead of Zod internals)
type ExportedProject = z.infer<typeof exportedProjectSchema>;
type ExportedWorkspace = z.infer<typeof exportedWorkspaceSchema>;
type ExportedAgentSession = z.infer<typeof exportedAgentSessionSchema>;
type ExportedTerminalSession = z.infer<typeof exportedTerminalSessionSchema>;
type ExportedUserSettings = z.infer<typeof exportedUserSettingsSchema>;

// ============================================================================
// Helpers
// ============================================================================

const toISOString = (date: Date | null): string | null => (date ? date.toISOString() : null);
const parseDate = (str: string | null): Date | null => (str ? new Date(str) : null);

function exportedConversationMetadata(workspace: WorkspaceForExport) {
  const metadata = workspace.conversationMetadata;
  if (!metadata) {
    return null;
  }
  const { workspaceId: _workspaceId, generatedAt, ...fields } = metadata;
  return { ...fields, generatedAt: toISOString(generatedAt) };
}

function exportedPRFields(workspace: WorkspaceForExport) {
  const fields = workspacePrSnapshotService.projectCollection(
    workspace.prs,
    workspace.prMonitoring?.enabled ?? false
  );
  return {
    prUrl: fields.prUrl,
    prNumber: fields.prNumber,
    prState: fields.prState,
    prReviewState: fields.prReviewState,
    prCiStatus: fields.prCiStatus,
    ratchetState: fields.ratchetState,
    prReviewLastCommentId: fields.prReviewLastCommentId,
    prUpdatedAt: toISOString(fields.prUpdatedAt),
    prCiFailedAt: toISOString(fields.prCiFailedAt),
    prCiLastNotifiedAt: toISOString(fields.prCiLastNotifiedAt),
    prReviewLastCheckedAt: toISOString(fields.prReviewLastCheckedAt),
  };
}

/**
 * The six run-script fields a v4 export file carries, flattened out of
 * `WorkspaceRunScript`.
 *
 * Extracted rather than inlined into the workspace mapper because the mapper is
 * at the lint's complexity ceiling and every `??` on a joined row costs a branch.
 * `postRunCommand` is absent because the format never carried it.
 */
function exportedRunScriptFields(workspace: WorkspaceForExport) {
  const runScript = workspace.runScript;
  return {
    runScriptCommand: runScript?.command ?? null,
    runScriptCleanupCommand: runScript?.cleanupCommand ?? null,
    runScriptPid: runScript?.pid ?? null,
    runScriptPort: runScript?.port ?? null,
    runScriptStartedAt: toISOString(runScript?.startedAt ?? null),
    runScriptStatus: runScript?.status ?? 'IDLE',
  };
}

// ============================================================================
// Import Functions
// ============================================================================

async function importProjects(
  projects: ExportedProject[],
  tx: TransactionClient,
  acceptedProjectIds: Set<string>
): Promise<ImportCounter> {
  const counter: ImportCounter = { imported: 0, skipped: 0 };

  for (const p of projects) {
    const existing = await tx.project.findUnique({ where: { id: p.id } });
    if (existing) {
      if (
        existing.slug === p.slug &&
        existing.repoPath === p.repoPath &&
        existing.worktreeBasePath === p.worktreeBasePath &&
        existing.githubOwner === p.githubOwner &&
        existing.githubRepo === p.githubRepo
      ) {
        acceptedProjectIds.add(p.id);
      }
      counter.skipped++;
      continue;
    }

    const slugConflict = await tx.project.findUnique({ where: { slug: p.slug } });
    if (slugConflict) {
      logger.warn('Skipping project due to slug conflict', { id: p.id, slug: p.slug });
      counter.skipped++;
      continue;
    }

    await tx.project.create({
      data: {
        id: p.id,
        name: p.name,
        slug: p.slug,
        repoPath: p.repoPath,
        worktreeBasePath: p.worktreeBasePath,
        defaultBranch: p.defaultBranch,
        githubOwner: p.githubOwner,
        githubRepo: p.githubRepo,
        issueProvider: p.issueProvider,
        // issueTrackerConfig is NOT imported — it contains encrypted keys that are machine-specific
        isArchived: p.isArchived,
        startupScriptCommand: p.startupScriptCommand,
        startupScriptPath: p.startupScriptPath,
        startupScriptTimeout: p.startupScriptTimeout,
        createdAt: new Date(p.createdAt),
        updatedAt: new Date(p.updatedAt),
      },
    });
    acceptedProjectIds.add(p.id);
    counter.imported++;
  }

  return counter;
}

function importedPRs(workspace: ExportedWorkspace, jsonNulls: RecoveryJsonNullLookup) {
  return workspace.prs.length
    ? workspace.prs.map(({ dedicatedSession: _dedicatedSession, ...pr }) => ({
        ...pr,
        syncedAt: parseDate(pr.syncedAt),
        detachedAt: parseDate(pr.detachedAt),
        ciFailedAt: parseDate(pr.ciFailedAt),
        ciLastNotifiedAt: parseDate(pr.ciLastNotifiedAt),
        reviewLastCheckedAt: parseDate(pr.reviewLastCheckedAt),
        observation: nullablePrismaJson(
          pr.observation,
          jsonNulls('WorkspacePR', pr.id, 'observation')
        ),
      }))
    : workspace.prUrl
      ? [
          {
            id: `legacy-pr-${workspace.id}`,
            url: workspace.prUrl,

            number: workspace.prNumber,
            state: workspace.prState,
            reviewState: workspace.prReviewState,
            ciStatus: workspace.prCiStatus,
            // A v4 file predating the projection never carried a conflict flag —
            // `ratchetState: 'MERGE_CONFLICT'` was the only place a conflict was
            // recorded, so that is what it restores from.
            hasMergeConflict: workspace.ratchetState === 'MERGE_CONFLICT',
            syncedAt: parseDate(workspace.prUpdatedAt),
            ciFailedAt: parseDate(workspace.prCiFailedAt),
            ciLastNotifiedAt: parseDate(workspace.prCiLastNotifiedAt),
            reviewLastCheckedAt: parseDate(workspace.prReviewLastCheckedAt),
            reviewLastCommentId: workspace.prReviewLastCommentId,
          },
        ]
      : [];
}

async function parentWorkspaceExists(workspace: ExportedWorkspace, tx: TransactionClient) {
  if (workspace.parentWorkspaceId !== null) {
    const parentWorkspace = await tx.workspace.findUnique({
      where: { id: workspace.parentWorkspaceId },
    });
    if (!parentWorkspace) {
      logger.warn('Skipping workspace due to missing parent workspace', {
        workspaceId: workspace.id,
        parentWorkspaceId: workspace.parentWorkspaceId,
      });
      return false;
    }
  }
  return true;
}

async function importWorkspaces(
  workspaces: ExportedWorkspace[],
  tx: TransactionClient,
  importedWorkspaceIds: string[],
  retainedChildEdges: ReadonlySet<string> = new Set(),
  jsonNulls: RecoveryJsonNullLookup = () => false
): Promise<ImportCounter> {
  const counter: ImportCounter = { imported: 0, skipped: 0 };
  const orderedWorkspaces = [...workspaces].sort(
    (a, b) => Number(a.parentWorkspaceId !== null) - Number(b.parentWorkspaceId !== null)
  );

  for (const workspace of orderedWorkspaces) {
    const project = await tx.project.findUnique({ where: { id: workspace.projectId } });
    if (!project) {
      logger.warn('Skipping workspace due to missing project', {
        workspaceId: workspace.id,
        projectId: workspace.projectId,
      });
      counter.skipped++;
      continue;
    }

    if (!(await parentWorkspaceExists(workspace, tx))) {
      counter.skipped++;
      continue;
    }

    await workspaceChildHistoryService.invalidateImportedWorkspace(tx, workspace.id);
    await tx.workspace.create({
      data: {
        id: workspace.id,
        projectId: workspace.projectId,
        parentWorkspaceId: workspace.parentWorkspaceId,
        name: workspace.name,
        description: workspace.description,
        status: ['NEW', 'PROVISIONING', 'ARCHIVING'].includes(workspace.status)
          ? 'FAILED'
          : workspace.status,
        worktreePath: workspace.worktreePath,
        branchName: workspace.branchName,
        isAutoGeneratedBranch: workspace.isAutoGeneratedBranch,
        creationSource: workspace.creationSource,
        creationMetadata: nullablePrismaJson(
          workspace.creationMetadata,
          jsonNulls('Workspace', workspace.id, 'creationMetadata')
        ),
        conversationMetadata: workspace.conversationMetadata
          ? {
              create: {
                ...workspace.conversationMetadata,
                generatedAt: parseDate(workspace.conversationMetadata.generatedAt),
              },
            }
          : undefined,
        initErrorMessage: workspace.initErrorMessage,
        initOutput: workspace.initOutput,
        initStartedAt: parseDate(workspace.initStartedAt),
        initCompletedAt: parseDate(workspace.initCompletedAt),
        initRetryCount: workspace.initRetryCount,
        githubIssueNumber: workspace.githubIssueNumber,
        githubIssueUrl: workspace.githubIssueUrl,
        linearIssueId: workspace.linearIssueId,
        linearIssueIdentifier: workspace.linearIssueIdentifier,
        linearIssueUrl: workspace.linearIssueUrl,
        defaultSessionProvider: workspace.defaultSessionProvider,
        // The v4 export carries the PR cache as flat workspace fields; it now
        // lives in the WorkspacePR row this create brings with it. Discovery
        // scheduling was never exported, so it restores at its defaults and the
        // next poll re-derives it.
        prDiscovery: {
          create: workspace.prDiscovery
            ? {
                lastCheckedAt: parseDate(workspace.prDiscovery.lastCheckedAt),
                retryCount: workspace.prDiscovery.retryCount,
                nextCheckAt: parseDate(workspace.prDiscovery.nextCheckAt),
              }
            : {},
        },
        prs: { create: importedPRs(workspace, jsonNulls) },
        // `ratchetState` is not among them: it is derived from the PR row above,
        // so restoring it would create a second copy to disagree with. It is still
        // read on the way in — for the conflict flag — and recomputed on the way
        // out, because the v4 format requires the field.
        // The v4 export carries six of the seven run-script fields as flat
        // workspace fields; they now live in the WorkspaceRunScript row this
        // create brings with it. `postRunCommand` was never exported, so it
        // restores as null and the next reconcile reads it back out of the
        // worktree's factory-factory.json.
        runScript: {
          create: {
            command: workspace.runScriptCommand,
            cleanupCommand: workspace.runScriptCleanupCommand,
            pid: null,
            port: null,
            startedAt: null,
            status: 'IDLE',
          },
        },
        hasHadSessions: workspace.hasHadSessions,
        createdAt: new Date(workspace.createdAt),
        updatedAt: new Date(workspace.updatedAt),
      },
    });
    if (!retainedChildEdges.has(JSON.stringify([workspace.parentWorkspaceId, workspace.id]))) {
      await workspaceChildHistoryService.recordImportedChild(tx, workspace);
    }
    importedWorkspaceIds.push(workspace.id);
    counter.imported++;
  }

  return counter;
}

async function importAgentSessions(
  sessions: ExportedAgentSession[],
  tx: TransactionClient,
  accountIds: ReadonlyMap<string, string> = new Map(),
  importedSessionIds: Set<string> = new Set(),
  jsonNulls: RecoveryJsonNullLookup = () => false
): Promise<ImportCounter> {
  const counter: ImportCounter = { imported: 0, skipped: 0 };

  for (const s of sessions) {
    const existing = await tx.agentSession.findUnique({ where: { id: s.id } });
    if (existing) {
      counter.skipped++;
      continue;
    }

    const workspace = await tx.workspace.findUnique({ where: { id: s.workspaceId } });
    if (!workspace) {
      logger.warn('Skipping agent session due to missing workspace', {
        sessionId: s.id,
        workspaceId: s.workspaceId,
      });
      counter.skipped++;
      continue;
    }

    if (s.workspacePrId !== null) {
      const pr = await tx.workspacePR.findUnique({ where: { id: s.workspacePrId } });
      if (!pr || pr.workspaceId !== s.workspaceId) {
        logger.warn('Skipping agent session due to missing or foreign PR association', {
          sessionId: s.id,
          workspaceId: s.workspaceId,
          workspacePrId: s.workspacePrId,
        });
        counter.skipped++;
        continue;
      }
    }

    await tx.agentSession.create({
      data: {
        id: s.id,
        workspaceId: s.workspaceId,
        name: s.name,
        workflow: s.workflow,
        workspacePrId: s.workspacePrId,
        model: s.model,
        status: s.status === 'RUNNING' ? 'IDLE' : s.status,
        provider: s.provider,
        codexAccountId: restoredAccountId(s.codexAccountId, accountIds),
        providerSessionId: s.providerSessionId,
        providerProjectPath: s.providerProjectPath,
        providerProcessPid: null,
        providerMetadata: nullablePrismaJson(
          s.providerMetadata,
          jsonNulls('AgentSession', s.id, 'providerMetadata')
        ),
        createdAt: new Date(s.createdAt),
        updatedAt: new Date(s.updatedAt),
      },
    });
    importedSessionIds.add(s.id);
    counter.imported++;
  }

  return counter;
}

async function importTerminalSessions(
  sessions: ExportedTerminalSession[],
  tx: TransactionClient
): Promise<ImportCounter> {
  const counter: ImportCounter = { imported: 0, skipped: 0 };

  for (const s of sessions) {
    const existing = await tx.terminalSession.findUnique({ where: { id: s.id } });
    if (existing) {
      counter.skipped++;
      continue;
    }

    const workspace = await tx.workspace.findUnique({ where: { id: s.workspaceId } });
    if (!workspace) {
      logger.warn('Skipping terminal session due to missing workspace', {
        sessionId: s.id,
        workspaceId: s.workspaceId,
      });
      counter.skipped++;
      continue;
    }

    await tx.terminalSession.create({
      data: {
        id: s.id,
        workspaceId: s.workspaceId,
        name: s.name,
        status: 'IDLE',
        pid: null,
        createdAt: new Date(s.createdAt),
        updatedAt: new Date(s.updatedAt),
      },
    });
    counter.imported++;
  }

  return counter;
}

async function importUserSettings(
  settings: ExportedUserSettings | null,
  tx: TransactionClient
): Promise<{ imported: boolean; skipped: boolean }> {
  if (!settings) {
    return { imported: false, skipped: false };
  }

  const existing = await tx.userSettings.findFirst({ where: { userId: 'default' } });
  if (existing) {
    return { imported: false, skipped: true };
  }

  await tx.userSettings.create({
    data: {
      userId: 'default',
      preferredIde: settings.preferredIde,
      customIdeCommand: settings.customIdeCommand,
      playSoundOnComplete: settings.playSoundOnComplete,
      notificationSoundPath: settings.notificationSoundPath,
      // Ratchet settings
      ratchetEnabled: settings.ratchetEnabled,
      ratchetReplyToPrComments: settings.ratchetReplyToPrComments,
      ratchetReviewTriggerMode: settings.ratchetReviewTriggerMode,
      defaultSessionProvider: settings.defaultSessionProvider,
      defaultClaudeModel: settings.defaultClaudeModel,
      defaultCodexModel: settings.defaultCodexModel,
      defaultClaudeReasoningEffort: settings.defaultClaudeReasoningEffort,
      defaultCodexReasoningEffort: settings.defaultCodexReasoningEffort,
      defaultWorkspacePermissions: settings.defaultWorkspacePermissions,
      // Adversarial review settings
      reviewerSessionProvider: settings.reviewerSessionProvider,
      reviewerClaudeModel: settings.reviewerClaudeModel,
      reviewerCodexModel: settings.reviewerCodexModel,
      postReviewToGitHub: settings.postReviewToGitHub,
      voiceModeEnabled: settings.voiceModeEnabled,
      voiceTtsModel: settings.voiceTtsModel,
      voiceTtsSpeed: settings.voiceTtsSpeed,
      voiceUtteranceEndMs: settings.voiceUtteranceEndMs,
      voiceBargeInSustainedMs: settings.voiceBargeInSustainedMs,
      appearanceColorScheme: settings.appearanceColorScheme,
      appearanceBackgroundColor: settings.appearanceBackgroundColor,
      appearanceForegroundColor: settings.appearanceForegroundColor,
      appearanceFontScale: settings.appearanceFontScale,
      appearanceFontSans: settings.appearanceFontSans,
      appearanceFontMono: settings.appearanceFontMono,
      // Note: workspaceOrder and cachedSlashCommands are intentionally not imported
      // as they are rebuild-able cache data. deepgramApiKeyEncrypted is never
      // exported (secret), so it's left unset here too.
    },
  });

  return { imported: true, skipped: false };
}

// ============================================================================
// Service Class
// ============================================================================

class DataBackupService {
  /**
   * Export all data for backup/migration.
   * Exports a consistent relational snapshot with explicit logical recovery coverage.
   * Excludes cached data (workspaceOrder, cachedSlashCommands) which will rebuild.
   * Version 8 retains normalized effect proof and restores automation inactive.
   */
  async exportData(appVersion: string): Promise<ExportData> {
    logger.info('Exporting database data');

    // Fetch all data
    const {
      projects,
      workspaces,
      agentSessions,
      terminalSessions,
      userSettings,
      codexAccounts,
      durable,
      closedSessions,
    } = await dataBackupAccessor.getSnapshotForExport();

    const exportData: ExportData = {
      meta: {
        recovery: recoveryManifest(),
        exportedAt: new Date().toISOString(),
        version: appVersion,
        schemaVersion: 8,
      },
      data: {
        archives: await exportSessionArchives(
          closedSessions,
          new Map(workspaces.map((row) => [row.id, row.worktreePath]))
        ),
        durable,
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          slug: p.slug,
          repoPath: p.repoPath,
          worktreeBasePath: p.worktreeBasePath,
          defaultBranch: p.defaultBranch,
          githubOwner: p.githubOwner,
          githubRepo: p.githubRepo,
          issueProvider: p.issueProvider,
          issueTrackerConfig: sanitizeIssueTrackerConfig(p.issueTrackerConfig),
          isArchived: p.isArchived,
          startupScriptCommand: p.startupScriptCommand,
          startupScriptPath: p.startupScriptPath,
          startupScriptTimeout: p.startupScriptTimeout,
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
        })),
        workspaces: workspaces.map((w) => ({
          ...exportPRBackupState(w),
          conversationMetadata: exportedConversationMetadata(w),
          id: w.id,
          projectId: w.projectId,
          periodicTaskId: w.periodicTaskId,
          parentWorkspaceId: w.parentWorkspaceId,
          name: w.name,
          description: w.description,
          status: w.status,
          worktreePath: w.worktreePath,
          branchName: w.branchName,
          isAutoGeneratedBranch: w.isAutoGeneratedBranch,
          creationSource: w.creationSource,
          creationMetadata: recoveryJsonSchema.parse(w.creationMetadata),
          initErrorMessage: w.initErrorMessage,
          initOutput: w.initOutput,
          initStartedAt: toISOString(w.initStartedAt),
          initCompletedAt: toISOString(w.initCompletedAt),
          initRetryCount: w.initRetryCount,
          // Flattened out of WorkspaceRunScript, same as the PR cache below: the
          // v4 export format carries these as workspace fields.
          ...exportedRunScriptFields(w),
          githubIssueNumber: w.githubIssueNumber,
          githubIssueUrl: w.githubIssueUrl,
          linearIssueId: w.linearIssueId,
          linearIssueIdentifier: w.linearIssueIdentifier,
          linearIssueUrl: w.linearIssueUrl,
          defaultSessionProvider: w.defaultSessionProvider,
          // Flattened out of WorkspacePR: the v4 export format carries the PR
          // cache as workspace fields, and `prUpdatedAt` keeps the name it has in
          // files already on disk even though the column is now `syncedAt`.
          ...exportedPRFields(w),
          // Phase 3+ ratchet tracking fields. Flattened out of WorkspaceRatchet:
          // the v4 export format carries them as workspace fields, and
          // `ratchetLastCiRunId` keeps the name it has in files already on disk.
          ratchetEnabled: w.prMonitoring?.enabled ?? false,
          ratchetLastCheckedAt: toISOString(w.prMonitoring?.lastCheckedAt ?? null),
          ratchetActiveSessionId: null,
          ratchetLastCiRunId: null,
          hasHadSessions: w.hasHadSessions,
          createdAt: w.createdAt.toISOString(),
          updatedAt: w.updatedAt.toISOString(),
        })),
        codexAccounts,
        agentSessions: agentSessions.map((s) => ({
          id: s.id,
          workspaceId: s.workspaceId,
          name: s.name,
          workflow: s.workflow,
          workspacePrId: s.workspacePrId,
          model: s.model,
          status: s.status,
          provider: s.provider,
          codexAccountId: s.codexAccountId,
          providerSessionId: s.providerSessionId,
          providerProjectPath: s.providerProjectPath,
          providerProcessPid: s.providerProcessPid,
          providerMetadata: recoveryJsonSchema.parse(s.providerMetadata),
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
        })),
        terminalSessions: terminalSessions.map((s) => ({
          id: s.id,
          workspaceId: s.workspaceId,
          name: s.name,
          status: s.status,
          pid: s.pid,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
        })),
        userSettings: userSettings
          ? {
              preferredIde: userSettings.preferredIde,
              customIdeCommand: userSettings.customIdeCommand,
              playSoundOnComplete: userSettings.playSoundOnComplete,
              notificationSoundPath: userSettings.notificationSoundPath,
              // Ratchet settings
              ratchetEnabled: userSettings.ratchetEnabled,
              ratchetReplyToPrComments: userSettings.ratchetReplyToPrComments,
              ratchetReviewTriggerMode: userSettings.ratchetReviewTriggerMode,
              defaultSessionProvider: userSettings.defaultSessionProvider,
              defaultClaudeModel: userSettings.defaultClaudeModel,
              defaultCodexModel: userSettings.defaultCodexModel,
              defaultClaudeReasoningEffort: userSettings.defaultClaudeReasoningEffort,
              defaultCodexReasoningEffort: userSettings.defaultCodexReasoningEffort,
              defaultWorkspacePermissions: userSettings.defaultWorkspacePermissions,
              // Adversarial review settings
              reviewerSessionProvider: userSettings.reviewerSessionProvider,
              reviewerClaudeModel: userSettings.reviewerClaudeModel,
              reviewerCodexModel: userSettings.reviewerCodexModel,
              postReviewToGitHub: userSettings.postReviewToGitHub,
              voiceModeEnabled: userSettings.voiceModeEnabled,
              voiceTtsModel: userSettings.voiceTtsModel,
              voiceTtsSpeed: userSettings.voiceTtsSpeed,
              voiceUtteranceEndMs: userSettings.voiceUtteranceEndMs,
              voiceBargeInSustainedMs: userSettings.voiceBargeInSustainedMs,
              appearanceColorScheme: normalizeColorScheme(userSettings.appearanceColorScheme),
              appearanceBackgroundColor: userSettings.appearanceBackgroundColor,
              appearanceForegroundColor: userSettings.appearanceForegroundColor,
              appearanceFontScale: userSettings.appearanceFontScale,
              appearanceFontSans: userSettings.appearanceFontSans,
              appearanceFontMono: userSettings.appearanceFontMono,
              // Note: workspaceOrder and cachedSlashCommands are intentionally excluded
              // as they are rebuild-able cache data (per design doc). The Deepgram
              // API key is excluded too — it's a secret, not a preference.
            }
          : null,
      },
    };

    validateWireBudget(exportData);
    logger.info('Export completed', {
      projectCount: projects.length,
      workspaceCount: workspaces.length,
      agentSessionCount: agentSessions.length,
      terminalSessionCount: terminalSessions.length,
    });

    return exportData;
  }

  /**
   * Import data from a backup file.
   * Accepts current and supported legacy backup payloads.
   * Existing workspace subgraphs and incompatible project parents are skipped.
   * Returns counts of imported/skipped records.
   * All imports are wrapped in a transaction for atomicity.
   */
  async importData(input: ExportData): Promise<ImportResults> {
    validateWireBudget(input);
    input = exportDataSchema.parse(input);
    validateWireBudget(input);
    validateRecoveryManifest(input);
    logger.info('Starting data import', {
      schemaVersion: input.meta.schemaVersion,
      exportedAt: input.meta.exportedAt,
      projectCount: input.data.projects.length,
      workspaceCount: input.data.workspaces.length,
    });

    // Import in dependency order within a transaction for atomicity
    let importedArchiveIds: string[] = [];
    const results = await dataBackupAccessor.runInTransaction(async (tx) => {
      const jsonNulls = input.data.durable
        ? recoveryJsonNullLookup(input.data.durable.jsonStorage)
        : () => false;
      const acceptedProjectIds = new Set<string>();
      const projects = await importProjects(input.data.projects, tx, acceptedProjectIds);
      const graph = await selectRecoveryGraph(input.data, tx, acceptedProjectIds);
      const importedWorkspaceIds: string[] = [];
      const childEdges = new Set(
        input.data.durable?.workspaceChildOrigin.map((row) =>
          JSON.stringify([row.parentWorkspaceId, row.childWorkspaceId])
        )
      );
      const workspaces = await importWorkspaces(
        graph.workspaces,
        tx,
        importedWorkspaceIds,
        childEdges,
        jsonNulls
      );
      const accountIds = await restoreCodexAccountMetadata(tx, input.data.codexAccounts);
      const importedSessionIds = new Set<string>();
      const agentSessions = await importAgentSessions(
        graph.agentSessions,
        tx,
        accountIds,
        importedSessionIds,
        jsonNulls
      );
      await restorePRBackupState(
        input.data.workspaces,
        importedWorkspaceIds,
        tx,
        importedSessionIds
      );
      const terminalSessions = await importTerminalSessions(graph.terminalSessions, tx);
      workspaces.skipped += input.data.workspaces.length - graph.workspaces.length;
      agentSessions.skipped += input.data.agentSessions.length - graph.agentSessions.length;
      terminalSessions.skipped +=
        input.data.terminalSessions.length - graph.terminalSessions.length;
      if (input.data.durable) {
        const taskIds = await restorePeriodicRecovery(
          tx,
          input.data.durable,
          acceptedProjectIds,
          new Set(importedWorkspaceIds)
        );
        await restoreWorkspaceScheduleLinks(
          tx,
          input.data.workspaces,
          new Set(importedWorkspaceIds),
          taskIds
        );
        await restoreRecoveryNotifications(tx, input.data.durable, new Set(importedWorkspaceIds));
        const agentParents = await restoreAgentConfigRecovery(
          tx,
          input.data.durable,
          acceptedProjectIds
        );
        const runIds = await restoreAgentHistoryRecovery(
          tx,
          input.data.durable,
          agentParents,
          new Set(importedWorkspaceIds)
        );
        const importedIds = {
          projects: acceptedProjectIds,
          workspaces: new Set(importedWorkspaceIds),
          sessions: importedSessionIds,
          runs: runIds,
        };
        await restoreRetainedWorkspaceRecovery(tx, input.data, importedIds);
        await restoreRetainedSessionRecovery(tx, input.data, importedIds);
        await restoreRecoveryDecisions(tx, input.data, importedIds, agentParents.definitions);
      }
      if (input.data.archives) {
        importedArchiveIds = await restoreSessionArchives(
          tx,
          input.data.archives,
          new Set(importedWorkspaceIds)
        );
      }
      const userSettings = await importUserSettings(input.data.userSettings, tx);

      return {
        projects,
        workspaces,
        agentSessions,
        terminalSessions,
        userSettings,
      };
    });

    // The committed PENDING rows retain exact payloads if publication is interrupted.
    await publishRestoredSessionArchives(importedArchiveIds);
    logger.info('Import completed', {
      schemaVersion: input.meta.schemaVersion,
      projects: results.projects,
      workspaces: results.workspaces,
      agentSessions: results.agentSessions,
      terminalSessions: results.terminalSessions,
    });

    return results;
  }
}

// Export singleton instance
export const dataBackupService = new DataBackupService();
