import type { Prisma } from '@prisma-gen/client';
import { z } from 'zod';
import type { AcpProviderIdentityEvent } from '@/backend/services/session/service/acp';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { AcpEventProcessor } from './acp-event-processor';
import type { closedSessionPersistenceService } from './closed-session-persistence.service';
import type { SessionRepository } from './session.repository';

export class SessionProviderIdentityService {
  constructor(
    private readonly dependencies: {
      repository: Pick<
        SessionRepository,
        'getSessionById' | 'getWorkspaceById' | 'rolloverProviderIdentity'
      >;
      sessionDomainService: Pick<
        SessionDomainService,
        'getTranscriptSnapshot' | 'resetProviderHistory' | 'suspendProviderHistory'
      >;
      archive: Pick<typeof closedSessionPersistenceService, 'persistClosedSession'>;
      processor: Pick<AcpEventProcessor, 'clearPendingToolCalls' | 'setReplaySuppression'>;
    }
  ) {}

  async reconcile(event: AcpProviderIdentityEvent): Promise<void> {
    event.assertCurrent();
    const session = await this.dependencies.repository.getSessionById(event.sessionId);
    event.assertCurrent();
    if (
      !session ||
      session.provider !== event.provider ||
      session.providerSessionId !== event.outcome.previousProviderSessionId
    ) {
      throw new Error(`Stale provider identity for session ${event.sessionId}`);
    }
    const workspace = await this.dependencies.repository.getWorkspaceById(session.workspaceId);
    event.assertCurrent();
    const resumeHistory = this.dependencies.sessionDomainService.suspendProviderHistory(
      event.sessionId
    );
    try {
      const messages = this.dependencies.sessionDomainService.getTranscriptSnapshot(
        event.sessionId
      );
      if (messages.length > 0) {
        if (!workspace?.worktreePath) {
          throw new Error('Cannot archive previous provider transcript');
        }
        await this.dependencies.archive.persistClosedSession({
          sessionId: session.id,
          workspaceId: session.workspaceId,
          worktreePath: workspace.worktreePath,
          name: session.name,
          workflow: session.workflow,
          provider: session.provider,
          model: session.model,
          startedAt: session.createdAt,
          messages,
        });
        event.assertCurrent();
      }

      const capturedAt = new Date().toISOString();
      const metadata = session.providerMetadata;
      const previousMetadata =
        metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
      const previousRollovers = Array.isArray(previousMetadata.providerIdentityRollovers)
        ? previousMetadata.providerIdentityRollovers
        : [];
      const providerMetadata = {
        ...previousMetadata,
        acpConfigSnapshot: {
          provider: event.provider,
          providerSessionId: event.providerSessionId,
          configOptions: event.configOptions,
          capturedAt,
        },
        providerIdentityRollovers: [
          ...previousRollovers,
          {
            previousProviderSessionId: event.outcome.previousProviderSessionId,
            providerSessionId: event.providerSessionId,
            incarnationId: event.incarnationId,
            reason: event.outcome.reason,
            capturedAt,
            transcriptPolicy: 'archive_then_clear',
            archivedMessageCount: messages.length,
          },
        ],
      };
      // JSON serialization removes undefined optional ACP fields before the Prisma boundary.
      const persistedMetadata: Prisma.InputJsonValue = z
        .record(z.string(), z.json())
        .parse(JSON.parse(JSON.stringify(providerMetadata)));
      event.assertCurrent();
      await this.dependencies.repository.rolloverProviderIdentity(event.sessionId, {
        previousProviderSessionId: event.outcome.previousProviderSessionId,
        providerSessionId: event.providerSessionId,
        expectedUpdatedAt: session.updatedAt,
        expectedProviderMetadata: session.providerMetadata,
        providerMetadata: persistedMetadata,
      });
      // A stop may race the atomic commit. Creation stays serialized until this callback
      // returns, so finish the matching in-memory reset even for a now-stopped candidate.
      this.dependencies.processor.clearPendingToolCalls(event.sessionId);
      this.dependencies.processor.setReplaySuppression(event.sessionId, false);
      this.dependencies.sessionDomainService.resetProviderHistory(
        event.sessionId,
        event.providerSessionId
      );
    } finally {
      resumeHistory();
    }
  }
}
