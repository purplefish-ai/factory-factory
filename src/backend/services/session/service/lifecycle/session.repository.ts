import type { Prisma, Workspace } from '@prisma-gen/client';
import {
  type AgentSessionRecord,
  agentSessionAccessor,
  type ProviderIdentityExpectation,
  type ProviderIdentityRolloverInput,
} from '@/backend/services/session/resources/agent-session.accessor';
import { workspaceDataService } from '@/backend/services/workspace';

function isMetadataRecord(value: Prisma.JsonValue | undefined): value is Prisma.JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

type SessionUpdateData = Partial<
  Pick<
    AgentSessionRecord,
    | 'status'
    | 'model'
    | 'providerProcessPid'
    | 'providerSessionId'
    | 'providerProjectPath'
    | 'providerMetadata'
  >
>;

type ConditionalSessionUpdateData = Omit<SessionUpdateData, 'providerSessionId'>;

type SessionAccessor = {
  updateIfProviderIdentity(
    id: string,
    expected: ProviderIdentityExpectation,
    data: ConditionalSessionUpdateData
  ): Promise<number>;
  rolloverProviderIdentity(id: string, input: ProviderIdentityRolloverInput): Promise<number>;
  findById(id: string): Promise<AgentSessionRecord | null>;
  findByWorkspaceId(workspaceId: string): Promise<AgentSessionRecord[]>;
  update(id: string, data: SessionUpdateData): Promise<AgentSessionRecord>;
  updateIfStatus(
    id: string,
    data: ConditionalSessionUpdateData,
    allowedStatuses: AgentSessionRecord['status'][]
  ): Promise<number>;
  delete(id: string): Promise<AgentSessionRecord>;
  recoverStaleRunning(): Promise<number>;
};

type WorkspaceAccessor = {
  findById(id: string): Promise<Workspace | null>;
  recordSessionPresence(id: string): Promise<void>;
};

export class SessionRepository {
  constructor(
    private readonly sessions: SessionAccessor = agentSessionAccessor,
    private readonly workspaces: WorkspaceAccessor = workspaceDataService
  ) {}

  getSessionById(sessionId: string): Promise<AgentSessionRecord | null> {
    return this.sessions.findById(sessionId);
  }

  getSessionsByWorkspaceId(workspaceId: string): Promise<AgentSessionRecord[]> {
    return this.sessions.findByWorkspaceId(workspaceId);
  }

  getWorkspaceById(workspaceId: string): Promise<Workspace | null> {
    return this.workspaces.findById(workspaceId);
  }

  markWorkspaceHasHadSessions(workspaceId: string): Promise<void> {
    return this.workspaces.recordSessionPresence(workspaceId);
  }

  updateSession(sessionId: string, data: SessionUpdateData): Promise<AgentSessionRecord> {
    return this.updateSessionWithGuards(sessionId, data);
  }

  updateSessionIfStatus(
    sessionId: string,
    data: ConditionalSessionUpdateData,
    allowedStatuses: AgentSessionRecord['status'][]
  ): Promise<number> {
    return this.sessions.updateIfStatus(sessionId, data, allowedStatuses);
  }

  /** Dedicated lifecycle exception; ordinary writes still enforce immutable identity. */
  async rolloverProviderIdentity(
    sessionId: string,
    input: ProviderIdentityRolloverInput
  ): Promise<void> {
    if (
      !(input.previousProviderSessionId && input.providerSessionId) ||
      input.previousProviderSessionId === input.providerSessionId
    ) {
      throw new Error('Provider identity rollover requires distinct non-empty identities');
    }
    if ((await this.sessions.rolloverProviderIdentity(sessionId, input)) !== 1) {
      throw new Error(`Stale provider identity reconciliation for session ${sessionId}`);
    }
  }

  private async updateSessionWithGuards(
    sessionId: string,
    data: SessionUpdateData
  ): Promise<AgentSessionRecord> {
    if (Object.hasOwn(data, 'providerSessionId')) {
      const current = await this.sessions.findById(sessionId);
      if (!current) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const currentSessionId = current.providerSessionId;
      const nextSessionId = data.providerSessionId ?? null;
      if (currentSessionId && nextSessionId !== currentSessionId) {
        throw new Error(
          `providerSessionId is immutable for session ${sessionId}: ${currentSessionId} -> ${String(nextSessionId)}`
        );
      }
    }

    const metadata = data.providerMetadata;
    if (isMetadataRecord(metadata) && Object.hasOwn(metadata, 'acpConfigSnapshot')) {
      return this.updateConfigSnapshotMetadata(sessionId, data, metadata);
    }

    return this.sessions.update(sessionId, data);
  }

  private async updateConfigSnapshotMetadata(
    sessionId: string,
    data: SessionUpdateData,
    metadata: Prisma.JsonObject
  ): Promise<AgentSessionRecord> {
    const current = await this.sessions.findById(sessionId);
    if (!current) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const snapshot = metadata.acpConfigSnapshot;
    if (
      current.providerSessionId &&
      (!isMetadataRecord(snapshot) || snapshot.providerSessionId !== current.providerSessionId)
    ) {
      throw new Error(`Stale provider config snapshot for session ${sessionId}`);
    }
    const currentMetadata = current.providerMetadata;
    const durableMetadata = isMetadataRecord(currentMetadata) ? currentMetadata : {};
    const { providerSessionId: _identity, ...guardedData } = data;
    const mergedMetadata = {
      ...durableMetadata,
      ...metadata,
      ...(durableMetadata.providerIdentityRollovers !== undefined
        ? { providerIdentityRollovers: durableMetadata.providerIdentityRollovers }
        : {}),
    };
    if (
      (await this.sessions.updateIfProviderIdentity(sessionId, current, {
        ...guardedData,
        providerMetadata: mergedMetadata,
      })) !== 1
    ) {
      throw new Error(`Stale provider metadata reconciliation for session ${sessionId}`);
    }
    const persisted = await this.sessions.findById(sessionId);
    if (!persisted) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return persisted;
  }

  deleteSession(sessionId: string): Promise<AgentSessionRecord> {
    return this.sessions.delete(sessionId);
  }

  recoverStaleRunningSessions(): Promise<number> {
    return this.sessions.recoverStaleRunning();
  }
}

export const sessionRepository = new SessionRepository();
