import type { z } from 'zod';
import { PR_DEDICATED_WORKFLOW, type PRMonitoringEventPayload } from '@/shared/pr-monitoring';

interface Backup {
  data: {
    projects: readonly { id: string; slug: string }[];
    terminalSessions: readonly { id: string }[];
    workspaces: readonly {
      id: string;
      projectId: string;
      ratchetActiveSessionId: string | null;
      prMonitoring: {
        recipientSessionId: string | null;
        legacySessionIds: readonly string[];
      } | null;
      parentWorkspaceId: string | null;
      prEvents: readonly {
        id: string;
        workspaceId: string;
        prId: string | null;
        deduplicationKey: string;
        deliveryId: string | null;
        deliverySessionId: string | null;
        payload: PRMonitoringEventPayload;
      }[];
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
function validateSourceIdentities(data: Backup, ctx: z.RefinementCtx): boolean {
  let valid = true;
  const unique = (values: readonly string[], path: string[]) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['data', ...path],
        message: 'Duplicate source identity',
      });
      valid = false;
    }
  };
  unique(
    data.data.projects.map((row) => row.id),
    ['projects']
  );
  unique(
    data.data.projects.map((row) => row.slug),
    ['projects']
  );
  unique(
    data.data.workspaces.map((row) => row.id),
    ['workspaces']
  );
  unique(
    data.data.agentSessions.map((row) => row.id),
    ['agentSessions']
  );
  unique(
    data.data.terminalSessions.map((row) => row.id),
    ['terminalSessions']
  );
  unique(
    data.data.workspaces.flatMap((row) => row.prEvents.map((event) => event.id)),
    ['workspaces']
  );
  unique(
    data.data.workspaces.flatMap((row) => row.prs.map((pr) => pr.id)),
    ['workspaces']
  );
  return valid;
}

function validateSourceSessionReferences(data: Backup, ctx: z.RefinementCtx): void {
  const owners = new Map(
    data.data.agentSessions.map((session) => [session.id, session.workspaceId])
  );
  for (const [index, workspace] of data.data.workspaces.entries()) {
    const references = [
      workspace.ratchetActiveSessionId,
      workspace.prMonitoring?.recipientSessionId,
      ...(workspace.prMonitoring?.legacySessionIds ?? []),
      ...workspace.prEvents.map((event) => event.deliverySessionId),
    ];
    if (references.some((id) => id != null && owners.has(id) && owners.get(id) !== workspace.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['data', 'workspaces', index],
        message: 'Declared session must belong to its file workspace',
      });
    }
  }
}

function validateSourceAncestry(data: Backup, ctx: z.RefinementCtx): void {
  const workspaces = new Map(data.data.workspaces.map((workspace) => [workspace.id, workspace]));
  for (const [index, workspace] of data.data.workspaces.entries()) {
    if (workspace.parentWorkspaceId === null) {
      continue;
    }
    const parent = workspaces.get(workspace.parentWorkspaceId);
    if (
      !parent ||
      parent === workspace ||
      parent.parentWorkspaceId !== null ||
      parent.projectId !== workspace.projectId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['data', 'workspaces', index, 'parentWorkspaceId'],
        message: 'Parent must be a different file-owned root in the same project',
      });
    }
  }
}

function validateSourceReceipts(data: Backup, ctx: z.RefinementCtx): void {
  const receipts = new Map<string, string>();
  for (const [index, workspace] of data.data.workspaces.entries()) {
    for (const event of workspace.prEvents) {
      if (event.deliveryId === null) {
        continue;
      }
      const owner = receipts.get(event.deliveryId);
      if (owner !== undefined && owner !== workspace.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['data', 'workspaces', index, 'prEvents'],
          message: 'Receipt members must belong to one workspace',
        });
      }
      receipts.set(event.deliveryId, workspace.id);
    }
  }
}

type BackupWorkspace = Backup['data']['workspaces'][number];
function eventOwnershipMatches(
  event: BackupWorkspace['prEvents'][number],
  workspaceId: string,
  prs: ReadonlySet<string>
): boolean {
  const target = event.payload.kind === 'MONITORING_ENABLED' ? event.payload : event.payload.target;
  return (
    event.workspaceId === workspaceId &&
    target.workspaceId === workspaceId &&
    (event.prId === null || prs.has(event.prId)) &&
    (!('prId' in target) || target.prId === event.prId)
  );
}

function validateSourceEvents(data: Backup, ctx: z.RefinementCtx): void {
  const prKeys = new Map<string, Set<string>>();
  for (const [index, workspace] of data.data.workspaces.entries()) {
    const keys = new Set<string>();
    const prs = new Set(workspace.prs.map((pr) => pr.id));
    workspace.prEvents.forEach((event) => {
      const issue = (message: string) =>
        ctx.addIssue({ code: 'custom', path: ['data', 'workspaces', index, 'prEvents'], message });
      if (!eventOwnershipMatches(event, workspace.id, prs)) {
        issue('Event and payload must belong to their declared workspace and PR');
      }
      const prDedup = event.prId === null ? undefined : prKeys.get(event.prId);
      if (keys.has(event.deduplicationKey) || prDedup?.has(event.deduplicationKey)) {
        issue('Duplicate event deduplication key');
      }
      keys.add(event.deduplicationKey);
      if (event.prId !== null) {
        const dedup = prDedup ?? new Set<string>();
        dedup.add(event.deduplicationKey);
        prKeys.set(event.prId, dedup);
      }
    });
  }
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
  if (!validateSourceIdentities(data, ctx)) {
    return;
  }
  validateSourceAncestry(data, ctx);
  validateSourceReceipts(data, ctx);
  validateSourceEvents(data, ctx);
  validateSourceSessionReferences(data, ctx);
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
