import type { z } from 'zod';

interface Backup {
  data: {
    workspaces: readonly {
      id: string;
      ratchetActivePrId: string | null;
      ratchetActiveSessionId: string | null;
      prs: readonly {
        id: string;
        url: string;
        detachedAt: string | null;
        ratchet: { activeSessionId: string | null };
      }[];
    }[];
    agentSessions: readonly { workspaceId: string; workspacePrId: string | null }[];
  };
}
/** PR identities must be unambiguous before restoring any database rows. */
export function validateBackupPRs(data: Backup, ctx: z.RefinementCtx): void {
  const ids = new Set<string>();
  const ownership = new Map<string, string>();
  for (const [index, workspace] of data.data.workspaces.entries()) {
    const urls = new Set<string>();
    for (const [prIndex, pr] of workspace.prs.entries()) {
      if (ids.has(pr.id) || urls.has(pr.url)) {
        ctx.addIssue({
          code: 'custom',
          path: ['data', 'workspaces', index, 'prs', prIndex],
          message: 'Duplicate PR identity or URL',
        });
      }
      ids.add(pr.id);
      urls.add(pr.url);
      ownership.set(pr.id, workspace.id);
    }
    validateOwnership(workspace, index, ctx);
  }
  for (const [index, session] of data.data.agentSessions.entries()) {
    if (session.workspacePrId && ownership.get(session.workspacePrId) !== session.workspaceId) {
      ctx.addIssue({
        code: 'custom',
        path: ['data', 'agentSessions', index, 'workspacePrId'],
        message: 'Session PR must belong to its workspace',
      });
    }
  }
}

function validateOwnership(
  workspace: Backup['data']['workspaces'][number],
  index: number,
  ctx: z.RefinementCtx
): void {
  const active = workspace.prs.find((pr) => pr.id === workspace.ratchetActivePrId);
  if (
    workspace.ratchetActivePrId &&
    (!(workspace.ratchetActiveSessionId && active) ||
      active.detachedAt ||
      active.ratchet.activeSessionId !== workspace.ratchetActiveSessionId)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['data', 'workspaces', index, 'ratchetActivePrId'],
      message: 'Active fixer must belong to an attached PR in this workspace',
    });
  }
}
