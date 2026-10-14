import type { z } from 'zod';
import { PR_DEDICATED_WORKFLOW } from '@/shared/pr-monitoring';

interface Backup {
  data: {
    workspaces: readonly {
      id: string;
      prs: readonly {
        id: string;
        url: string;
        dedicatedSession?: { sessionId: string | null } | null;
      }[];
    }[];
    agentSessions: readonly {
      id: string;
      workflow: string;
      workspaceId: string;
      workspacePrId: string | null;
    }[];
  };
}
function validateDedicatedBindings(data: Backup, ctx: z.RefinementCtx) {
  for (const [index, workspace] of data.data.workspaces.entries()) {
    for (const [prIndex, pr] of workspace.prs.entries()) {
      const sessionId = pr.dedicatedSession?.sessionId;
      if (sessionId === null || sessionId === undefined) {
        continue;
      }
      const session = data.data.agentSessions.find((row) => row.id === sessionId);
      if (
        !session ||
        session.workspaceId !== workspace.id ||
        session.workspacePrId !== pr.id ||
        session.workflow !== PR_DEDICATED_WORKFLOW
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['data', 'workspaces', index, 'prs', prIndex, 'dedicatedSession'],
          message: 'Dedicated conversation must belong to this PR and workspace',
        });
      }
    }
  }
}

/** PR identities must be unambiguous before restoring any database rows. */
export function validateBackupPRs(data: Backup, ctx: z.RefinementCtx): void {
  validateDedicatedBindings(data, ctx);
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

export function validateLegacyFixerOwnership(
  data: {
    data: {
      workspaces: readonly {
        ratchetActivePrId: string | null;
        ratchetActiveSessionId: string | null;
        prs: readonly {
          id: string;
          detachedAt: string | null;
          ratchet: { activeSessionId: string | null };
        }[];
      }[];
    };
  },
  ctx: z.RefinementCtx
): void {
  for (const [index, workspace] of data.data.workspaces.entries()) {
    const active = workspace.prs.find((pr) => pr.id === workspace.ratchetActivePrId);
    if (
      (workspace.ratchetActivePrId !== null || workspace.ratchetActiveSessionId !== null) &&
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
}
