import { prisma } from '@/backend/db';
import { ApplicationError } from '@/backend/lib/application-error';
import { retainedEventOriginSchema } from '@/shared/agent-history';
import { eventWorkspaceIdentitySchema } from '@/shared/event-agent-launch';
import { retainedReferenceAllowed, type RecoveryImportedIds } from '@/shared/recovery-graph';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import type { AgentRun, Prisma, Workspace } from '@prisma-gen/client';

type Origin = { runId: string; workspaceId: string; projectId: string };
/** Retained scalars deliberately outlive the workspace, run and project. */
export const workspaceLaunchOriginAccessor = {
  read(input: { projectId: string; workspaceId: string }) {
    return prisma.$transaction(async (tx) => {
      const origin = await tx.workspaceLaunchOrigin.findUnique({
        where: { workspaceId: input.workspaceId },
      });
      const workspace = await tx.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { projectId: true, creationSource: true, creationMetadata: true },
      });
      if (
        (workspace && workspace.projectId !== input.projectId) ||
        (origin && origin.projectId !== input.projectId)
      ) {
        throw new ApplicationError('NOT_FOUND', 'Workspace origin not found in this project.');
      }
      if (origin && workspace) {
        assertLiveIdentity(origin, workspace);
      }
      return origin
        ? retainedEventOriginSchema.parse({
            projectId: origin.projectId,
            workspaceId: origin.workspaceId,
            runId: origin.runId,
            workspaceState: workspace ? 'LIVE' : 'DELETED',
          })
        : null;
    });
  },
  invalidateImportedCoverage(tx: Prisma.TransactionClient, workspaceId: string) {
    return tx.workspaceLaunchOrigin.updateMany({
      where: { workspaceId },
      data: { childHistoryVersion: null },
    });
  },
  find(tx: Prisma.TransactionClient, input: Origin) {
    return tx.workspaceLaunchOrigin.findFirst({
      where: { OR: [{ runId: input.runId }, { workspaceId: input.workspaceId }] },
    });
  },
  create(tx: Prisma.TransactionClient, input: Origin) {
    return tx.workspaceLaunchOrigin.create({ data: { ...input, childHistoryVersion: 1 } });
  },
};

function assertLiveIdentity(
  origin: Origin,
  workspace: Pick<Workspace, 'creationSource' | 'creationMetadata'>
) {
  const identity = eventWorkspaceIdentitySchema.safeParse(workspace.creationMetadata);
  if (
    workspace.creationSource !== 'EVENT_AGENT' ||
    !identity.success ||
    identity.data.runId !== origin.runId
  ) {
    throw new ApplicationError(
      'NOT_FOUND',
      'Workspace origin does not match its creation identity.'
    );
  }
}

export async function restoreRecoveryWorkspaceOrigins(
  tx: Prisma.TransactionClient,
  data: ExportData['data'],
  ids: RecoveryImportedIds,
  incompleteParents: ReadonlySet<string>
) {
  const sourceWorkspaces = new Set(data.workspaces.map((row) => row.id));
  const sourceProjects = new Set(data.projects.map((row) => row.id));
  const sourceRuns = new Set(data.durable?.agentRun.map((row) => row.id));
  for (const row of data.durable?.workspaceLaunchOrigin ?? []) {
    const workspace = await tx.workspace.findUnique({ where: { id: row.workspaceId } });
    const run = await tx.agentRun.findUnique({ where: { id: row.runId } });
    if (
      !(
        retainedReferenceAllowed(sourceWorkspaces, ids.workspaces, row.workspaceId, !!workspace) &&
        retainedReferenceAllowed(
          sourceProjects,
          ids.projects,
          row.projectId,
          !!(await tx.project.findUnique({ where: { id: row.projectId } }))
        ) &&
        retainedReferenceAllowed(sourceRuns, ids.runs, row.runId, !!run)
      )
    ) {
      continue;
    }
    if (await workspaceLaunchOriginAccessor.find(tx, row)) {
      continue;
    }
    assertRecoveryRunReservation(row, run);
    assertLiveRecoveryIdentity(row, workspace);
    const expectedChildren = new Set(
      data.durable?.workspaceChildOrigin
        .filter((child) => child.parentWorkspaceId === row.workspaceId)
        .map((child) => child.childWorkspaceId)
    );
    const actualChildren = await tx.workspaceChildOrigin.findMany({
      where: { parentWorkspaceId: row.workspaceId },
    });
    const complete =
      actualChildren.length === expectedChildren.size &&
      actualChildren.every((child) => expectedChildren.has(child.childWorkspaceId));
    await tx.workspaceLaunchOrigin.create({
      data: {
        ...row,
        childHistoryVersion:
          incompleteParents.has(row.workspaceId) || !complete ? null : row.childHistoryVersion,
      },
    });
  }
}

function assertRecoveryRunReservation(row: Origin, run: AgentRun | null) {
  if (
    run &&
    (run.reservedWorkspaceId !== row.workspaceId ||
      (run.workspaceId !== null && run.workspaceId !== row.workspaceId))
  ) {
    throw new ApplicationError(
      'INVALID_INPUT',
      'Imported origin contradicts run workspace reservation'
    );
  }
}

function assertLiveRecoveryIdentity(origin: Origin, workspace: Workspace | null) {
  if (!workspace) {
    return;
  }
  if (workspace.projectId !== origin.projectId) {
    throw new ApplicationError(
      'INVALID_INPUT',
      'Imported workspace origin belongs to another project'
    );
  }
  assertLiveIdentity(origin, workspace);
}
