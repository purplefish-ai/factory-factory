import { sessionDataService } from '@/backend/services/session';
import { workspaceDataService } from '@/backend/services/workspace';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import type { Prisma } from '@prisma-gen/client';

type BackupData = ExportData['data'];

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

/** Reserve the complete normalized source graph in the private import transaction. */
export async function planLegacyImport(tx: Prisma.TransactionClient, data: BackupData) {
  const identities = await workspaceDataService.readBackupIdentities(tx, {
    projects: data.projects,
    workspaceIds: data.workspaces.map((workspace) => workspace.id),
    prIds: data.workspaces.flatMap((workspace) => workspace.prs.map((pr) => pr.id)),
  });
  const projectsById = new Map(identities.projects.map((project) => [project.id, project]));
  const existingSlugs = new Set(identities.projects.map((project) => project.slug));
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
  for (const project of data.projects) {
    const existing = projectsById.get(project.id);
    if (existing) {
      if (identityFields.every((field) => existing[field] === project[field])) {
        eligibleProjectIds.add(project.id);
      }
    } else if (!existingSlugs.has(project.slug)) {
      createProjectIds.add(project.id);
      eligibleProjectIds.add(project.id);
    }
  }
  const references = workspaceSessionReferences(data);
  const existingSessionIds = await sessionDataService.findExistingBackupSessionIds(tx, [
    ...data.agentSessions.map((session) => session.id),
    ...[...references.values()].flat(),
  ]);
  const eventConflicts = await workspaceDataService.findBackupEventConflicts(
    tx,
    data.workspaces.flatMap((workspace) => workspace.prEvents)
  );
  const eligibleWorkspaceIds = new Set(
    data.workspaces
      .filter(
        (workspace) =>
          eligibleProjectIds.has(workspace.projectId) &&
          !identities.workspaceIds.has(workspace.id) &&
          !workspace.prs.some((pr) => identities.prIds.has(pr.id)) &&
          !references.get(workspace.id)?.some((id) => existingSessionIds.has(id)) &&
          !eventConflicts.has(workspace.id)
      )
      .map((workspace) => workspace.id)
  );
  // Source validation admits only roots and direct children, so one pass suffices.
  for (const workspace of data.workspaces) {
    if (
      workspace.parentWorkspaceId !== null &&
      !eligibleWorkspaceIds.has(workspace.parentWorkspaceId)
    ) {
      eligibleWorkspaceIds.delete(workspace.id);
    }
  }
  return { createProjectIds, eligibleWorkspaceIds };
}
