import type { WorkspaceParent } from '@/shared/workspace-summary';
import type { Prisma } from '@prisma-gen/client';
import { pendingPREventWhere } from './workspace-ratchet.accessor';

export const workspaceFamilyInclude = {
  parentWorkspace: {
    select: {
      id: true,
      name: true,
      projectId: true,
      project: { select: { name: true, slug: true } },
    },
  },
  _count: {
    select: {
      prEvents: { where: pendingPREventWhere },
      childWorkspaces: { where: { status: { not: 'ARCHIVED' } } },
    },
  },
} satisfies Prisma.WorkspaceInclude;

export type WorkspaceFamilyFields = {
  parentWorkspace?: WorkspaceParent | null;
  childWorkspaceCount?: number;
};

type FamilySource = {
  parentWorkspace?: {
    id: string;
    name: string;
    projectId: string;
    project: { name: string; slug: string };
  } | null;
  _count?: { childWorkspaces?: number };
};

/** Omission remains unknown for older/partial reads; null is an absent parent. */
export function projectWorkspaceFamily(row: FamilySource): WorkspaceFamilyFields {
  return {
    ...(row.parentWorkspace === undefined
      ? {}
      : {
          parentWorkspace: row.parentWorkspace
            ? {
                id: row.parentWorkspace.id,
                name: row.parentWorkspace.name,
                projectId: row.parentWorkspace.projectId,
                projectName: row.parentWorkspace.project.name,
                projectSlug: row.parentWorkspace.project.slug,
              }
            : null,
        }),
    ...(row._count?.childWorkspaces === undefined
      ? {}
      : { childWorkspaceCount: row._count.childWorkspaces }),
  };
}
