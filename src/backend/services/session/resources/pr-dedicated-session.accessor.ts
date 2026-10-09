import type { AgentSession, Prisma, SessionProvider, Workspace } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import { agentSessionAccessor } from '@/backend/services/session/resources/agent-session.accessor';
import { PR_DEDICATED_WORKFLOW, type PRTarget } from '@/shared/pr-monitoring';

export interface AcquirePRDedicatedSessionInput extends PRTarget {
  provider: SessionProvider;
  model: string;
  maxSessions: number;
  expectedBindingRevision?: number;
  isCurrent?: () => boolean;
}
export type PRDedicatedSessionAcquisition =
  | { outcome: 'created' | 'reused'; session: AgentSession }
  | { outcome: 'limit_reached' | 'unavailable' };

class AcquisitionCancelled extends Error {}

class PRDedicatedSessionAccessor {
  acquire(input: AcquirePRDedicatedSessionInput): Promise<PRDedicatedSessionAcquisition> {
    return agentSessionAccessor
      .runWorkspaceAcquisition(input.workspaceId, () =>
        prisma.$transaction((tx) => this.acquireInTransaction(tx, input))
      )
      .catch((error: unknown) => {
        if (error instanceof AcquisitionCancelled) {
          return { outcome: 'unavailable' as const };
        }
        throw error;
      });
  }
  async findWorkspace(target: PRTarget): Promise<Workspace | null> {
    const pr = await prisma.workspacePR.findFirst({
      where: {
        id: target.prId,
        workspaceId: target.workspaceId,
        detachedAt: null,
        workspace: { status: 'READY' },
      },
      include: { workspace: true },
    });
    return pr?.workspace ?? null;
  }
  async find(target: PRTarget): Promise<AgentSession | null> {
    const pr = await prisma.workspacePR.findFirst({
      where: { id: target.prId, workspaceId: target.workspaceId, detachedAt: null },
      include: { dedicatedSession: { include: { session: true } } },
    });
    const session = pr?.dedicatedSession?.session;
    return session && this.owns(target, session) ? session : null;
  }
  async restore(
    tx: Prisma.TransactionClient,
    input: PRTarget & { sessionId: string | null }
  ): Promise<boolean> {
    const pr = await tx.workspacePR.findFirst({
      where: { id: input.prId, workspaceId: input.workspaceId },
    });
    if (!pr) {
      return false;
    }
    if (input.sessionId) {
      const session = await tx.agentSession.findUnique({ where: { id: input.sessionId } });
      const binding = await tx.workspacePRDedicatedSession.findUnique({
        where: { sessionId: input.sessionId },
      });
      if (!(session && this.owns(input, session)) || (binding && binding.prId !== input.prId)) {
        return false;
      }
    }
    await tx.workspacePRDedicatedSession.upsert({
      where: { prId: input.prId },
      create: { prId: input.prId, sessionId: input.sessionId },
      update: { sessionId: input.sessionId },
    });
    return true;
  }
  private owns(target: PRTarget, session: AgentSession): boolean {
    return (
      session.workspaceId === target.workspaceId &&
      session.workspacePrId === target.prId &&
      session.workflow === PR_DEDICATED_WORKFLOW
    );
  }
  private async acquireInTransaction(
    tx: Prisma.TransactionClient,
    input: AcquirePRDedicatedSessionInput
  ): Promise<PRDedicatedSessionAcquisition> {
    if (input.isCurrent?.() === false) {
      return { outcome: 'unavailable' };
    }
    const pr = await tx.workspacePR.findFirst({
      where: { id: input.prId, workspaceId: input.workspaceId, detachedAt: null },
      include: {
        workspace: { include: { prMonitoring: true } },
        dedicatedSession: { include: { session: true } },
      },
    });
    const config = pr?.workspace.prMonitoring;
    if (
      input.isCurrent?.() === false ||
      !pr ||
      pr.workspace.status !== 'READY' ||
      !config?.enabled ||
      config.deliveryMode !== 'DEDICATED' ||
      config.deliveryPauseReason ||
      (input.expectedBindingRevision !== undefined &&
        config.bindingRevision !== input.expectedBindingRevision)
    ) {
      return { outcome: 'unavailable' };
    }
    const session = pr.dedicatedSession?.session;
    if (session) {
      return this.owns(input, session)
        ? { outcome: 'reused', session }
        : { outcome: 'unavailable' };
    }
    const count = await tx.agentSession.count({
      where: { workspaceId: input.workspaceId, status: { in: ['RUNNING', 'IDLE'] } },
    });
    if (input.isCurrent?.() === false) {
      return { outcome: 'unavailable' };
    }
    if (count >= input.maxSessions) {
      return { outcome: 'limit_reached' };
    }
    const created = await tx.agentSession.create({
      data: {
        workspaceId: input.workspaceId,
        workspacePrId: input.prId,
        workflow: PR_DEDICATED_WORKFLOW,
        name: `PR ${pr.number ?? pr.id}`,
        provider: input.provider,
        model: input.model,
        providerProjectPath: pr.workspace.worktreePath,
      },
    });
    if (input.isCurrent?.() === false) {
      throw new AcquisitionCancelled();
    }
    await tx.workspacePRDedicatedSession.upsert({
      where: { prId: input.prId },
      create: { prId: input.prId, sessionId: created.id },
      update: { sessionId: created.id },
    });
    if (input.isCurrent?.() === false) {
      throw new AcquisitionCancelled();
    }
    return { outcome: 'created', session: created };
  }
}
export const prDedicatedSessionAccessor = new PRDedicatedSessionAccessor();
