import { prisma } from '@/backend/db';
import { ADVERSARIAL_REVIEW_WORKFLOW } from '@/shared/adversarial-review';
import { SessionStatus } from '@/shared/core';
import { eventSessionCreationSchema, type EventSessionCreation } from '@/shared/event-agent-launch';
import { type AgentSession, Prisma, type SessionProvider } from '@prisma-gen/client';
import { agentSessionLaunchOriginAccessor } from './agent-session-launch-origin.accessor';
import { findEventSessionForCreation } from './event-session-creation';

export type AgentSessionRecord = AgentSession;

/**
 * The workspace columns session reads need. A full workspace row carries the
 * startup log and `creationMetadata` (base64 initial attachments), and
 * `findById` runs on every dispatch and session load.
 */
const sessionWorkspaceSelect = {
  status: true,
  worktreePath: true,
  initErrorMessage: true,
} satisfies Prisma.WorkspaceSelect;

export type AgentSessionRecordWithWorkspace = Prisma.AgentSessionGetPayload<{
  include: { workspace: { select: typeof sessionWorkspaceSelect } };
}>;

/**
 * A session without `providerMetadata` (provider config snapshots), for list
 * reads that never use it. Reads that need it go through `findById`.
 */
export type AgentSessionSummaryRecord = Omit<AgentSession, 'providerMetadata'>;

const ACTIVE_AGENT_SESSION_STATUSES: SessionStatus[] = [SessionStatus.RUNNING, SessionStatus.IDLE];

/**
 * Sessions that use a workspace session slot. Finished adversarial reviews keep
 * their transcript but no slot; this mirrors isFinishedAdversarialReview, where
 * an empty provider session ID means the review never started. The limit is
 * checked only at creation, so resuming a finished review can briefly exceed it.
 */
export function workspaceSessionSlotWhere(workspaceId: string): Prisma.AgentSessionWhereInput {
  return {
    workspaceId,
    status: { in: ACTIVE_AGENT_SESSION_STATUSES },
    NOT: {
      AND: [
        { workflow: ADVERSARIAL_REVIEW_WORKFLOW },
        { status: SessionStatus.IDLE },
        { providerSessionId: { not: null } },
        { providerSessionId: { not: '' } },
      ],
    },
  };
}

export interface AgentSessionFilters {
  status?: SessionStatus;
  provider?: SessionProvider;
  limit?: number;
}

export interface CreateAgentSessionInput {
  workspaceId: string;
  name?: string;
  workflow: string;
  workspacePrId?: string | null;
  model: string;
  provider: SessionProvider;
  codexAccountId?: string | null;
  providerProjectPath?: string | null;
  providerMetadata?: Prisma.InputJsonValue;
}

export interface UpdateAgentSessionInput {
  name?: string;
  workflow?: string;
  model?: string;
  status?: SessionStatus;
  provider?: SessionProvider;
  providerMetadata?: Prisma.InputJsonValue | null;
  providerSessionId?: string | null;
  providerProjectPath?: string | null;
  providerProcessPid?: number | null;
}

const toAgentSessionUpdateData = (
  data: UpdateAgentSessionInput
): Prisma.AgentSessionUpdateManyMutationInput => {
  if ('codexAccountId' in data) {
    throw new Error('A conversation Codex account binding is immutable');
  }
  return {
    name: data.name,
    workflow: data.workflow,
    model: data.model,
    status: data.status,
    provider: data.provider,
    providerMetadata:
      data.providerMetadata === undefined
        ? undefined
        : data.providerMetadata === null
          ? Prisma.JsonNull
          : data.providerMetadata,
    providerSessionId: data.providerSessionId,
    providerProjectPath: data.providerProjectPath,
    providerProcessPid: data.providerProcessPid,
  };
};

export interface CreateLimitedAgentSessionInput extends CreateAgentSessionInput {
  maxSessions: number;
}

export type LimitedAgentSessionCreation =
  | { outcome: 'limit_reached' }
  | { outcome: 'created'; session: AgentSessionRecord };

export interface ProviderIdentityRolloverInput {
  previousProviderSessionId: string;
  providerSessionId: string;
  expectedUpdatedAt: Date;
  expectedProviderMetadata: AgentSessionRecord['providerMetadata'];
  providerMetadata: Prisma.InputJsonValue;
}

export type ProviderIdentityExpectation = Pick<
  AgentSessionRecord,
  'providerSessionId' | 'providerMetadata' | 'updatedAt'
>;

export interface AgentSessionAccessor {
  runWorkspaceAcquisition<T>(workspaceId: string, operation: () => Promise<T>): Promise<T>;
  updateIfProviderIdentity(
    id: string,
    expected: ProviderIdentityExpectation,
    data: Omit<UpdateAgentSessionInput, 'providerSessionId'>
  ): Promise<number>;
  rolloverProviderIdentity(id: string, input: ProviderIdentityRolloverInput): Promise<number>;
  createEventOnce(
    input: EventSessionCreation,
    providerMetadata: Prisma.InputJsonValue
  ): Promise<AgentSessionRecord>;
  create(data: CreateAgentSessionInput): Promise<AgentSessionRecord>;
  createWithinWorkspaceLimit(
    data: CreateLimitedAgentSessionInput
  ): Promise<LimitedAgentSessionCreation>;
  findById(id: string): Promise<AgentSessionRecordWithWorkspace | null>;
  findByIds(ids: string[]): Promise<AgentSessionRecord[]>;
  findExistingBackupSessionIds(
    tx: Prisma.TransactionClient,
    ids: readonly string[]
  ): Promise<Set<string>>;
  findByWorkspaceId(
    workspaceId: string,
    filters?: AgentSessionFilters
  ): Promise<AgentSessionSummaryRecord[]>;
  update(id: string, data: UpdateAgentSessionInput): Promise<AgentSessionRecord>;
  updateIfStatus(
    id: string,
    data: UpdateAgentSessionInput,
    allowedStatuses: SessionStatus[]
  ): Promise<number>;
  delete(id: string): Promise<AgentSessionRecord>;
  findWithPid(): Promise<AgentSessionRecord[]>;
  recoverStaleRunning(): Promise<number>;
}

class PrismaAgentSessionAccessor implements AgentSessionAccessor {
  /** Serialises per-workspace acquisition to prevent count-then-create races. */
  private readonly workspaceAcquisitionQueue = new Map<string, Promise<unknown>>();

  createEventOnce(input: EventSessionCreation, providerMetadata: Prisma.InputJsonValue) {
    const data = eventSessionCreationSchema.parse(input);
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "AgentSession" SET "id" = "id" WHERE 0`;
      const existing = await findEventSessionForCreation(tx, data);
      if (existing) {
        return existing;
      }
      const session = await tx.agentSession.create({
        data: {
          id: data.id,
          workspaceId: data.workspaceId,
          name: 'Agent',
          workflow: 'event-agent',
          provider: data.execution.provider,
          model: data.execution.model,
          codexAccountId: data.execution.codexAccountId,
          providerMetadata,
        },
      });
      await agentSessionLaunchOriginAccessor.create(tx, data);
      return session;
    });
  }

  async create(data: CreateAgentSessionInput): Promise<AgentSessionRecord> {
    return await prisma.agentSession.create({
      data: {
        workspaceId: data.workspaceId,
        name: data.name,
        workflow: data.workflow,
        workspacePrId: data.workspacePrId,
        model: data.model,
        provider: data.provider,
        ...(data.codexAccountId !== undefined ? { codexAccountId: data.codexAccountId } : {}),
        providerProjectPath: data.providerProjectPath ?? null,
        ...(data.providerMetadata !== undefined ? { providerMetadata: data.providerMetadata } : {}),
      },
    });
  }

  createWithinWorkspaceLimit(
    data: CreateLimitedAgentSessionInput
  ): Promise<LimitedAgentSessionCreation> {
    return this.runWorkspaceAcquisition(data.workspaceId, () =>
      this.doCreateWithinWorkspaceLimit(data)
    );
  }

  findById(id: string): Promise<AgentSessionRecordWithWorkspace | null> {
    return prisma.agentSession.findUnique({
      where: { id },
      include: { workspace: { select: sessionWorkspaceSelect } },
    });
  }

  findByIds(ids: string[]): Promise<AgentSessionRecord[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }

    return prisma.agentSession.findMany({
      where: {
        id: { in: ids },
      },
    });
  }

  async findExistingBackupSessionIds(tx: Prisma.TransactionClient, ids: readonly string[]) {
    const existing = new Set<string>();
    const unique = [...new Set(ids)];
    for (let index = 0; index < unique.length; index += 100) {
      const rows = await tx.agentSession.findMany({
        where: { id: { in: unique.slice(index, index + 100) } },
        select: { id: true },
      });
      for (const row of rows) {
        existing.add(row.id);
      }
    }
    return existing;
  }

  findByWorkspaceId(
    workspaceId: string,
    filters?: AgentSessionFilters
  ): Promise<AgentSessionSummaryRecord[]> {
    const where: Prisma.AgentSessionWhereInput = { workspaceId };

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.provider) {
      where.provider = filters.provider;
    }

    return prisma.agentSession.findMany({
      where,
      omit: { providerMetadata: true },
      take: filters?.limit,
      orderBy: { createdAt: 'asc' },
    });
  }

  update(id: string, data: UpdateAgentSessionInput): Promise<AgentSessionRecord> {
    return prisma.agentSession.update({
      where: { id },
      data: toAgentSessionUpdateData(data),
    });
  }

  async updateIfStatus(
    id: string,
    data: UpdateAgentSessionInput,
    allowedStatuses: SessionStatus[]
  ): Promise<number> {
    if (allowedStatuses.length === 0) {
      return 0;
    }

    const result = await prisma.agentSession.updateMany({
      where: {
        id,
        status: { in: allowedStatuses },
      },
      data: toAgentSessionUpdateData(data),
    });

    return result.count;
  }

  async updateIfProviderIdentity(
    id: string,
    expected: ProviderIdentityExpectation,
    data: Omit<UpdateAgentSessionInput, 'providerSessionId'>
  ): Promise<number> {
    const result = await prisma.agentSession.updateMany({
      where: {
        id,
        providerSessionId: expected.providerSessionId,
        updatedAt: expected.updatedAt,
        providerMetadata: { equals: expected.providerMetadata ?? Prisma.AnyNull },
      },
      data: toAgentSessionUpdateData({ ...data, providerSessionId: undefined }),
    });
    return result.count;
  }

  async rolloverProviderIdentity(
    id: string,
    input: ProviderIdentityRolloverInput
  ): Promise<number> {
    const result = await prisma.agentSession.updateMany({
      where: {
        id,
        providerSessionId: input.previousProviderSessionId,
        updatedAt: input.expectedUpdatedAt,
        providerMetadata: { equals: input.expectedProviderMetadata ?? Prisma.AnyNull },
      },
      data: {
        providerSessionId: input.providerSessionId,
        providerMetadata: input.providerMetadata,
      },
    });
    return result.count;
  }

  delete(id: string): Promise<AgentSessionRecord> {
    return prisma.agentSession.delete({ where: { id } });
  }

  findWithPid(): Promise<AgentSessionRecord[]> {
    return prisma.agentSession.findMany({
      where: {
        providerProcessPid: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async recoverStaleRunning(): Promise<number> {
    const result = await prisma.agentSession.updateMany({
      where: {
        status: SessionStatus.RUNNING,
      },
      data: {
        status: SessionStatus.IDLE,
        providerProcessPid: null,
      },
    });

    return result.count;
  }

  async runWorkspaceAcquisition<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const prev = this.workspaceAcquisitionQueue.get(workspaceId) ?? Promise.resolve();
    const current = prev
      .catch(() => {
        /* swallow so previous failure doesn't block queue */
      })
      .then(operation);
    this.workspaceAcquisitionQueue.set(workspaceId, current);
    try {
      return await current;
    } finally {
      if (this.workspaceAcquisitionQueue.get(workspaceId) === current) {
        this.workspaceAcquisitionQueue.delete(workspaceId);
      }
    }
  }

  private async doCreateWithinWorkspaceLimit(
    data: CreateLimitedAgentSessionInput
  ): Promise<LimitedAgentSessionCreation> {
    const activeSessionCount = await prisma.agentSession.count({
      where: workspaceSessionSlotWhere(data.workspaceId),
    });

    if (activeSessionCount >= data.maxSessions) {
      return { outcome: 'limit_reached' };
    }

    const session = await this.create(data);
    return { outcome: 'created', session };
  }
}

export const agentSessionAccessor: AgentSessionAccessor = new PrismaAgentSessionAccessor();
