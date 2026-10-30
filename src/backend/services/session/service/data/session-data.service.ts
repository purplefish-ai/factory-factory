import { codexAccountService } from '@/backend/services/codex-accounts';
import {
  agentSessionAccessor,
  type AgentSessionRecord as PersistenceAgentSessionRecord,
  type AgentSessionRecordWithWorkspace as PersistenceAgentSessionRecordWithWorkspace,
} from '@/backend/services/session/resources/agent-session.accessor';
import {
  type ClosedSessionRecord,
  type ClosedSessionWithWorkspace,
  closedSessionAccessor,
} from '@/backend/services/session/resources/closed-session.accessor';
import { prDedicatedSessionAccessor } from '@/backend/services/session/resources/pr-dedicated-session.accessor';
import { createSessionLaunchMetadata } from '@/backend/services/session/service/lifecycle/session-launch-settings';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type {
  AcquirePRDedicatedSessionInput,
  PRDedicatedSessionAcquisition,
  AgentSessionRecord,
  AgentSessionRecordWithWorkspace,
} from '@/backend/services/session/types';
import type { SessionStatus } from '@/shared/core';
import type { PRTarget } from '@/shared/pr-monitoring';
import type { Prisma, SessionProvider } from '@prisma-gen/client';
import {
  sessionProviderResolverService,
  type SessionProviderResolverService,
} from './session-provider-resolver.service';

function toAgentSessionRecord(session: PersistenceAgentSessionRecord): AgentSessionRecord {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    name: session.name,
    workflow: session.workflow,
    workspacePrId: session.workspacePrId,
    model: session.model,
    status: session.status,
    provider: session.provider,
    codexAccountId: session.codexAccountId,
    providerSessionId: session.providerSessionId,
    providerProjectPath: session.providerProjectPath,
    providerProcessPid: session.providerProcessPid,
    providerMetadata: session.providerMetadata,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function toAgentSessionRecordWithWorkspace(
  session: PersistenceAgentSessionRecordWithWorkspace
): AgentSessionRecordWithWorkspace {
  return {
    ...toAgentSessionRecord(session),
    workspace: {
      status: session.workspace.status,
      worktreePath: session.workspace.worktreePath,
      initErrorMessage: session.workspace.initErrorMessage,
    },
  };
}

export interface SessionDataDependencies {
  providerResolver: Pick<SessionProviderResolverService, 'resolveSessionDefaults'>;
  accounts?: Pick<typeof codexAccountService, 'withAccountReservation'>;
}

class SessionDataImplementation {
  constructor(private readonly dependencies: SessionDataDependencies) {}

  // Agent sessions

  async findAgentSessionById(id: string): Promise<AgentSessionRecordWithWorkspace | null> {
    const session = await agentSessionAccessor.findById(id);
    return session ? toAgentSessionRecordWithWorkspace(session) : null;
  }

  async findAgentSessionsByIds(ids: string[]): Promise<AgentSessionRecord[]> {
    return (await agentSessionAccessor.findByIds(ids)).map(toAgentSessionRecord);
  }

  async findAgentSessionsByWorkspaceId(
    workspaceId: string,
    filters?: { status?: SessionStatus; provider?: SessionProvider; limit?: number }
  ): Promise<AgentSessionRecord[]> {
    return (await agentSessionAccessor.findByWorkspaceId(workspaceId, filters)).map(
      toAgentSessionRecord
    );
  }

  async createAgentSession(data: {
    workspaceId: string;
    name?: string;
    workspacePrId?: string;
    workflow: string;
    model?: string;
    accessMode?: string;
    reasoningEffort?: string | null;
    planModeEnabled?: boolean;
    provider?: SessionProvider;
    codexAccountId?: string;
    providerProjectPath?: string | null;
  }): Promise<AgentSessionRecord> {
    const defaults = await this.dependencies.providerResolver.resolveSessionDefaults({
      workspaceId: data.workspaceId,
      explicitProvider: data.provider,
      explicitModel: data.model,
    });
    const launchMetadata = createSessionLaunchMetadata(data);
    return this.withAccountBinding(defaults, data, async (codexAccountId) =>
      toAgentSessionRecord(
        await agentSessionAccessor.create({
          ...data,
          ...defaults,
          codexAccountId,
          ...(launchMetadata ? { providerMetadata: launchMetadata } : {}),
        })
      )
    );
  }

  async createAgentSessionWithinWorkspaceLimit(data: {
    workspaceId: string;
    name?: string;
    workspacePrId?: string;
    workflow: string;
    model?: string;
    accessMode?: string;
    reasoningEffort?: string | null;
    planModeEnabled?: boolean;
    provider?: SessionProvider;
    codexAccountId?: string;
    providerProjectPath?: string | null;
    maxSessions: number;
  }) {
    const defaults = await this.dependencies.providerResolver.resolveSessionDefaults({
      workspaceId: data.workspaceId,
      explicitProvider: data.provider,
      explicitModel: data.model,
    });
    const launchMetadata = createSessionLaunchMetadata(data);
    const result = await this.withAccountBinding(defaults, data, (codexAccountId) =>
      agentSessionAccessor.createWithinWorkspaceLimit({
        ...data,
        ...defaults,
        codexAccountId,
        ...(launchMetadata ? { providerMetadata: launchMetadata } : {}),
      })
    );
    return result.outcome === 'created'
      ? { ...result, session: toAgentSessionRecord(result.session) }
      : result;
  }

  async acquirePRDedicatedSession(
    input: AcquirePRDedicatedSessionInput
  ): Promise<PRDedicatedSessionAcquisition> {
    if (input.isCurrent?.() === false) {
      return { outcome: 'unavailable' as const };
    }
    const workspace = await prDedicatedSessionAccessor.findWorkspace(input);
    if (!workspace || input.isCurrent?.() === false) {
      return { outcome: 'unavailable' as const };
    }
    const defaults = await this.dependencies.providerResolver.resolveSessionDefaults({
      workspace,
      workspaceId: input.workspaceId,
      explicitProvider: input.provider,
      explicitModel: input.model,
    });
    if (input.isCurrent?.() === false) {
      return { outcome: 'unavailable' as const };
    }
    // Reuse is decided under the same acquisition lock/transaction as creation.
    // A deleted binding must fall through to a newly validated reservation.
    const reused = await prDedicatedSessionAccessor.acquire({
      ...input,
      ...defaults,
      reuseOnly: true,
    });
    if (reused.outcome !== 'missing') {
      return 'session' in reused
        ? { ...reused, session: toAgentSessionRecord(reused.session) }
        : reused;
    }
    const result = await this.withAccountBinding(defaults, input, (codexAccountId) =>
      prDedicatedSessionAccessor.acquire({ ...input, ...defaults, codexAccountId })
    );
    if (result.outcome === 'missing') {
      throw new Error('Dedicated session acquisition unexpectedly skipped creation');
    }
    return 'session' in result
      ? { ...result, session: toAgentSessionRecord(result.session) }
      : result;
  }
  private withAccountBinding<T>(
    defaults: { provider: SessionProvider; model: string },
    selection: { codexAccountId?: string; reasoningEffort?: string | null },
    create: (accountId: string | null) => Promise<T>
  ): Promise<T> {
    return defaults.provider === 'CODEX'
      ? (this.dependencies.accounts ?? codexAccountService).withAccountReservation(
          {
            accountId: selection.codexAccountId,
            model: defaults.model,
            ...(selection.reasoningEffort !== undefined
              ? { reasoningEffort: selection.reasoningEffort }
              : {}),
          },
          create
        )
      : selection.codexAccountId
        ? Promise.reject(new Error('A Codex account can only be selected for a Codex conversation'))
        : create(null);
  }

  async findPRDedicatedSession(target: PRTarget): Promise<AgentSessionRecord | null> {
    const session = await prDedicatedSessionAccessor.find(target);
    return session ? toAgentSessionRecord(session) : null;
  }
  restorePRDedicatedSession(
    tx: Prisma.TransactionClient,
    input: PRTarget & { sessionId: string | null }
  ) {
    return prDedicatedSessionAccessor.restore(tx, input);
  }

  updateAgentSession(
    id: string,
    data: {
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
  ): Promise<AgentSessionRecord> {
    return agentSessionAccessor.update(id, data).then(toAgentSessionRecord);
  }

  deleteAgentSession(id: string): Promise<AgentSessionRecord> {
    return agentSessionAccessor.delete(id).then((session) => {
      sessionDomainService.forgetProviderHistoryIdentity(id);
      return toAgentSessionRecord(session);
    });
  }

  findAgentSessionsWithPid(): Promise<AgentSessionRecord[]> {
    return agentSessionAccessor
      .findWithPid()
      .then((sessions) => sessions.map(toAgentSessionRecord));
  }

  // Closed sessions

  findClosedSessionsByWorkspaceId(
    workspaceId: string,
    limit: number
  ): Promise<ClosedSessionRecord[]> {
    return closedSessionAccessor.findByWorkspaceId(workspaceId, limit);
  }

  findClosedSessionByIdWithWorkspace(id: string): Promise<ClosedSessionWithWorkspace | null> {
    return closedSessionAccessor.findByIdWithWorkspace(id);
  }

  deleteClosedSession(id: string): Promise<ClosedSessionRecord> {
    return closedSessionAccessor.delete(id);
  }
}

export type SessionDataService = Pick<SessionDataImplementation, keyof SessionDataImplementation>;

export function createSessionDataService(
  dependencies: SessionDataDependencies
): SessionDataService {
  return new SessionDataImplementation(dependencies);
}

export const sessionDataService = createSessionDataService({
  providerResolver: sessionProviderResolverService,
});
