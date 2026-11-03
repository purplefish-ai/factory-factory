import { createLogger } from '@/backend/services/logger.service';
import { sessionDataService } from '@/backend/services/session';
import { workspaceDataService } from '@/backend/services/workspace';
import { backupPRIdentities } from '@/shared/backup-pr-identities';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import type { Prisma } from '@prisma-gen/client';

type BackupData = ExportData['data'];
const logger = createLogger('backup-admission');

function workspaceSessionReferences(data: BackupData) {
  const references = new Map<string, string[]>();
  for (const workspace of data.workspaces) {
    const ids = [
      workspace.ratchetActiveSessionId,
      workspace.prMonitoring?.recipientSessionId,
      ...(workspace.prMonitoring?.legacySessionIds ?? []),
      ...workspace.prs.map((pr) => pr.dedicatedSession?.sessionId),
      ...workspace.prEvents.map((event) => event.deliverySessionId),
    ];
    references.set(
      workspace.id,
      ids.filter((id): id is string => id != null)
    );
  }
  for (const session of data.agentSessions) {
    references.get(session.workspaceId)?.push(session.id);
  }
  return references;
}

function planProjects(
  projects: BackupData['projects'],
  existingProjects: Awaited<
    ReturnType<typeof workspaceDataService.readBackupIdentities>
  >['projects']
) {
  const projectsById = new Map(existingProjects.map((project) => [project.id, project]));
  const existingSlugs = new Set(existingProjects.map((project) => project.slug));
  const createProjectIds = new Set<string>();
  const eligibleProjectIds = new Set<string>();
  const identityFields = [
    'id',
    'slug',
    'repoPath',
    'worktreeBasePath',
    'githubOwner',
    'githubRepo',
  ] as const;
  for (const project of projects) {
    const existing = projectsById.get(project.id);
    if (existing) {
      if (identityFields.every((field) => existing[field] === project[field])) {
        eligibleProjectIds.add(project.id);
      } else {
        logger.warn('Skipping backup project', {
          projectId: project.id,
          reason: 'incompatible-project-identity',
        });
      }
    } else if (!existingSlugs.has(project.slug)) {
      createProjectIds.add(project.id);
      eligibleProjectIds.add(project.id);
    } else {
      logger.warn('Skipping backup project', {
        projectId: project.id,
        reason: 'project-slug-collision',
      });
    }
  }
  return { createProjectIds, eligibleProjectIds };
}

/** Reserve the complete normalized source graph in the private import transaction. */
export async function planLegacyImport(tx: Prisma.TransactionClient, data: BackupData) {
  const identities = await workspaceDataService.readBackupIdentities(tx, {
    projects: data.projects,
    workspaceIds: data.workspaces.map((workspace) => workspace.id),
    prIds: data.workspaces.flatMap((workspace) => backupPRIdentities(workspace).map((pr) => pr.id)),
  });
  const { createProjectIds, eligibleProjectIds } = planProjects(data.projects, identities.projects);
  const references = workspaceSessionReferences(data);
  const existingSessionIds = await sessionDataService.findExistingBackupSessionIds(tx, [
    ...data.agentSessions.map((session) => session.id),
    ...[...references.values()].flat(),
  ]);
  const eventConflicts = await workspaceDataService.findBackupEventConflicts(
    tx,
    data.workspaces.flatMap((workspace) => workspace.prEvents)
  );
  const eligibleWorkspaceIds = new Set<string>();
  for (const workspace of data.workspaces) {
    const reason = [
      !eligibleProjectIds.has(workspace.projectId) && 'project-unavailable',
      identities.workspaceIds.has(workspace.id) && 'workspace-id-collision',
      backupPRIdentities(workspace).some((pr) => identities.prIds.has(pr.id)) && 'pr-id-collision',
      references.get(workspace.id)?.some((id) => existingSessionIds.has(id)) &&
        'session-id-collision',
      eventConflicts.has(workspace.id) && 'event-or-receipt-collision',
    ].find(Boolean);
    if (reason) {
      logger.warn('Skipping backup workspace', { workspaceId: workspace.id, reason });
    } else {
      eligibleWorkspaceIds.add(workspace.id);
    }
  }
  // Source validation admits only roots and direct children, so one pass suffices.
  for (const workspace of data.workspaces) {
    if (
      workspace.parentWorkspaceId !== null &&
      !eligibleWorkspaceIds.has(workspace.parentWorkspaceId) &&
      eligibleWorkspaceIds.has(workspace.id)
    ) {
      eligibleWorkspaceIds.delete(workspace.id);
      logger.warn('Skipping backup child workspace', {
        workspaceId: workspace.id,
        reason: 'parent-not-admitted',
      });
    }
  }
  return { createProjectIds, eligibleWorkspaceIds };
}
