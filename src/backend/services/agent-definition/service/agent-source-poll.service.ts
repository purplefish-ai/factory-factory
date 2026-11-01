import { ApplicationError } from '@/backend/lib/application-error';
import { agentSourceAccessor } from '@/backend/services/agent-definition/resources/agent-source.accessor';
import { agentSourceHealthSchema } from '@/shared/agent-runtime';
import type { AgentGitHubSourcePort } from '@/shared/agent-source';
import { agentGithubCursorSchema } from '@/shared/agent-source-state';

export class AgentSourcePollService {
  constructor(
    private readonly source: AgentGitHubSourcePort,
    private readonly getPagesPerCycle: () => number
  ) {}

  private async repository(
    target: Awaited<ReturnType<typeof agentSourceAccessor.listTargets>>[number],
    signal: AbortSignal
  ) {
    let canonical: string | null = null;
    for (const repository of target.repositories) {
      signal.throwIfAborted();
      const identity = await this.source.getRepositoryIdentity(repository, signal);
      if (identity.id !== target.repositoryId) {
        throw new ApplicationError('CONFLICT', 'GitHub repository identity changed.');
      }
      canonical = identity.name;
    }
    if (!canonical) {
      throw new ApplicationError('PRECONDITION_FAILED', 'GitHub repository is not configured.');
    }
    return canonical;
  }

  async prepareBaseline(connectionId: string, signal: AbortSignal) {
    const target = (await agentSourceAccessor.listTargets()).find(
      (item) => item.connectionId === connectionId
    );
    if (!target) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'The source requires an active or starting trigger.'
      );
    }
    try {
      const repository = await this.repository(target, signal);
      const page = await this.source.listIssueEvents(
        { repository, repositoryId: target.repositoryId, page: 1, perPage: 100 },
        signal
      );
      signal.throwIfAborted();
      return await agentSourceAccessor.prepareBaseline(
        connectionId,
        page.events[0]?.providerEventId ?? null
      );
    } catch (error) {
      signal.throwIfAborted();
      await this.recordFailure(connectionId, error);
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'GitHub baseline preparation failed. Check source health and repository access.'
      );
    }
  }

  getBaseline(connectionId: string, id: string) {
    return agentSourceAccessor.getBaseline(connectionId, id);
  }

  async pollCycle(signal: AbortSignal) {
    for (const target of await agentSourceAccessor.listTargets()) {
      if (signal.aborted) {
        return;
      }
      try {
        await this.pollTarget(target, signal);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        const classification = await this.recordFailure(target.connectionId, error);
        if (classification === 'rate_limit') {
          return;
        }
      }
    }
  }

  private async recordFailure(connectionId: string, error: unknown) {
    const recovery = isContinuityFailure(error);
    const classification = this.source.classifyError(error);
    const reasons: Record<string, string> = {
      rate_limit: 'GITHUB_RATE_LIMITED',
      auth_required: 'GITHUB_AUTH_REQUIRED',
    };
    const reason = recovery
      ? 'GITHUB_CONTINUITY_LOST'
      : (reasons[classification] ?? 'GITHUB_SOURCE_UNAVAILABLE');
    await agentSourceAccessor.setFailure(connectionId, reason, recovery);
    return classification;
  }

  private async pollTarget(
    target: Awaited<ReturnType<typeof agentSourceAccessor.listTargets>>[number],
    signal: AbortSignal
  ) {
    const state = await agentSourceAccessor.getState(target.connectionId);
    if (
      state?.health &&
      agentSourceHealthSchema.parse(state.health).state === 'RECOVERY_REQUIRED'
    ) {
      return;
    }
    if (!state?.cursor) {
      await agentSourceAccessor.setFailure(target.connectionId, 'GITHUB_BASELINE_REQUIRED');
      return;
    }
    const repository = await this.repository(target, signal);
    await agentSourceAccessor.resume(target.connectionId);
    await this.pollRepository(target, repository, signal);
  }

  private async pollRepository(
    target: { connectionId: string; repositoryId: string },
    repository: string,
    signal: AbortSignal
  ) {
    let reads = 0;
    while (!signal.aborted) {
      const state = await agentSourceAccessor.getState(target.connectionId);
      const cursor = agentGithubCursorSchema.parse(state?.cursor);
      if (cursor.scan?.phase === 'FINALIZE') {
        await agentSourceAccessor.finalizeNextChunk(target.connectionId);
        const updated = await agentSourceAccessor.getState(target.connectionId);
        if (!agentGithubCursorSchema.parse(updated?.cursor).scan) {
          return;
        }
        continue;
      }
      if (reads >= this.getPagesPerCycle()) {
        return;
      }
      const pageNumber = cursor.scan?.nextPage ?? 1;
      const page = await this.source.listIssueEvents(
        { repository, repositoryId: target.repositoryId, page: pageNumber, perPage: 100 },
        signal
      );
      signal.throwIfAborted();
      reads++;
      await agentSourceAccessor.savePage(target.connectionId, pageNumber, page);
      const updated = await agentSourceAccessor.getState(target.connectionId);
      if (!agentGithubCursorSchema.parse(updated?.cursor).scan) {
        return;
      }
    }
  }
}

function isContinuityFailure(error: unknown) {
  return error instanceof ApplicationError && error.code === 'CONFLICT';
}
