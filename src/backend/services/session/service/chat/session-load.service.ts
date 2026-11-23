import { ApplicationError } from '@/backend/lib/application-error';
import type { ResolvedSessionConfigProjection } from '@/backend/services/session/service/config/session-config-projection';
import {
  isSameHistoryFile,
  statHistoryFile,
} from '@/backend/services/session/service/data/session-history-file';
import type { ProviderHistorySession } from '@/backend/services/session/service/data/session-provider-history-hydrator';
import type { SessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import type { RetainedStoreClaim } from '@/backend/services/session/service/store/session-store-retention';
import { finalizeInterruptedTranscriptToolCalls } from '@/backend/services/session/service/store/session-tool-call-recovery';
import { selectTranscriptPage } from '@/backend/services/session/service/store/session-transcript-page';
import {
  commandNameKey,
  isWorkspaceScopedCommandName,
  scanClaudeGlobalCommandsFromDisk,
  scanClaudeWorkspaceCommandsFromDisk,
} from '@/backend/services/session/service/store/slash-command-disk-scanner';
import type { CommandInfo, SessionDeltaEvent } from '@/shared/acp-protocol';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import { buildAcceptedMessageStateChange, buildQueuedMessage } from './chat-message-handlers/utils';
import type { SessionCommandOutcome } from './session-command.types';

export interface SessionLoadReplay {
  replayEvents: SessionDeltaEvent[];
  sessionRuntime: SessionRuntimeState;
}
export type SessionLoadRecord = ProviderHistorySession & {
  status: string;
  workspace: ProviderHistorySession['workspace'] & { status: string };
};
export interface PreparedSessionLoad {
  status: 'ready';
  sessionId: string;
  loadRequestId?: string;
  provider: 'CLAUDE' | 'CODEX';
  worktreePath: string | null;
}
export type SessionLoadResult =
  | PreparedSessionLoad
  | { status: 'error'; outcome: SessionCommandOutcome };
export interface SessionLoadDependencies {
  findSession(sessionId: string): Promise<SessionLoadRecord | null>;
  hydrateProviderHistory(sessionId: string, session: SessionLoadRecord): Promise<void>;
  hydrateLifecycleEvents(sessionId: string): Promise<void>;
  getRuntimeSnapshot(sessionId: string): SessionRuntimeState;
  domain: Pick<
    SessionDomainService,
    | 'claimRetainedStore'
    | 'getTranscriptSnapshot'
    | 'replaceTranscript'
    | 'consumeInitialMessage'
    | 'enqueue'
    | 'emitDelta'
    | 'finishLoad'
  > & {
    prepareLoad(sessionId: string, runtime: SessionRuntimeState): SessionLoadReplay;
  };
  config: {
    getSessionConfigProjection(sessionId: string): Promise<ResolvedSessionConfigProjection>;
  };
  getCachedCommands(provider: 'CLAUDE' | 'CODEX'): Promise<CommandInfo[] | null>;
  tryDispatchNextMessage(sessionId: string): Promise<void>;
}

/** Application load stages contain no requester or transport callbacks. */
export class SessionLoadService {
  /** Checks of retained stores in flight; a concurrent load waits for its session's. */
  private readonly retainedStoreChecks = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionLoadDependencies) {}

  async prepareLoad(input: {
    sessionId: string;
    loadRequestId?: string;
  }): Promise<SessionLoadResult> {
    const { sessionId, loadRequestId } = input;
    const session = await this.deps.findSession(sessionId);
    if (!session) {
      return {
        status: 'error',
        outcome: { replies: [{ type: 'error', error: { kind: 'session_not_found' } }] },
      };
    }
    await this.checkRetainedStore(sessionId);
    await this.deps.hydrateProviderHistory(sessionId, session);
    await this.deps.hydrateLifecycleEvents(sessionId);
    return {
      status: 'ready',
      sessionId,
      loadRequestId,
      provider: session.provider,
      worktreePath: session.workspace.worktreePath,
    };
  }

  /**
   * Claim a store kept after its last viewer left. Without a live runtime, its
   * history file may have changed since hydration (another client resumed the
   * session); then discard it so hydration reads the file again.
   */
  private checkRetainedStore(sessionId: string): Promise<void> {
    const claim = this.deps.domain.claimRetainedStore(sessionId);
    if (!claim) {
      return this.retainedStoreChecks.get(sessionId) ?? Promise.resolve();
    }
    const check = this.discardIfHistoryChanged(sessionId, claim).finally(() => {
      if (this.retainedStoreChecks.get(sessionId) === check) {
        this.retainedStoreChecks.delete(sessionId);
      }
    });
    this.retainedStoreChecks.set(sessionId, check);
    return check;
  }

  private async discardIfHistoryChanged(sessionId: string, claim: RetainedStoreClaim) {
    const runtimeAlive = () => this.deps.getRuntimeSnapshot(sessionId).processState === 'alive';
    if (runtimeAlive()) {
      return;
    }
    const recorded = claim.historyFile;
    const current = recorded ? await statHistoryFile(recorded.filePath) : null;
    if (!((recorded && current && isSameHistoryFile(recorded, current)) || runtimeAlive())) {
      claim.discard();
    }
  }

  /** Browse the loaded transcript without rehydration, which can renumber history.
   * An evicted/replaced cursor requires a fresh conversation load instead.
   */
  async readTranscriptPage(input: { sessionId: string; beforeMessageId: string }) {
    const session = await this.deps.findSession(input.sessionId);
    if (!session) {
      throw new ApplicationError('NOT_FOUND', 'Session not found');
    }
    return selectTranscriptPage(
      this.deps.domain.getTranscriptSnapshot(input.sessionId),
      input.beforeMessageId
    );
  }

  /** Capture runtime, recovery, and replay without yielding before the adapter publishes it. */
  captureReplay(prepared: PreparedSessionLoad): SessionLoadReplay {
    const { sessionId } = prepared;
    const runtime = this.deps.getRuntimeSnapshot(sessionId);
    if (runtime.processState === 'stopped') {
      const transcript = this.deps.domain.getTranscriptSnapshot(sessionId);
      const recovered = finalizeInterruptedTranscriptToolCalls(transcript, runtime.updatedAt);
      if (recovered !== transcript) {
        this.deps.domain.replaceTranscript(sessionId, recovered);
      }
    }
    return this.deps.domain.prepareLoad(sessionId, runtime);
  }

  /** Continue after the adapter publishes replay; preserve runtime/configuration/activation order. */
  async completeLoad(prepared: PreparedSessionLoad): Promise<void> {
    const { sessionId, provider, worktreePath } = prepared;
    this.deps.domain.finishLoad(sessionId);
    let resolved = await this.deps.config.getSessionConfigProjection(sessionId);
    let current = resolved.currentProjection();
    while ('retry' in current) {
      resolved = await current.retry;
      current = resolved.currentProjection();
    }
    const { capabilities, configOptions } = current;
    this.deps.domain.emitDelta(sessionId, { type: 'chat_capabilities', capabilities });
    if (configOptions.length > 0) {
      this.deps.domain.emitDelta(sessionId, { type: 'config_options_update', configOptions });
    }
    const cached = provider === 'CLAUDE' ? await this.deps.getCachedCommands(provider) : null;
    const slashCommands =
      provider === 'CLAUDE'
        ? buildClaudeSlashCommandsForLoad(cached, worktreePath)
        : (cached ?? []);
    if (provider === 'CLAUDE' || this.deps.getRuntimeSnapshot(sessionId).processState !== 'alive') {
      this.deps.domain.emitDelta(sessionId, { type: 'slash_commands', slashCommands });
    }
    const text = this.deps.domain.consumeInitialMessage(sessionId);
    if (!text) {
      return;
    }
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const message = buildQueuedMessage(id, { id, text, type: 'queue_message' }, text);
    const result = this.deps.domain.enqueue(sessionId, message);
    if ('error' in result) {
      return;
    }
    this.deps.domain.emitDelta(
      sessionId,
      buildAcceptedMessageStateChange(id, message, result.position)
    );
    await this.deps.tryDispatchNextMessage(sessionId);
  }
}

function buildClaudeSlashCommandsForLoad(
  cached: CommandInfo[] | null,
  worktreePath: string | null
): CommandInfo[] {
  const seen = new Set<string>();
  const commands = scanClaudeWorkspaceCommandsFromDisk(worktreePath, seen);
  if (cached) {
    for (const command of cached) {
      if (isWorkspaceScopedCommandName(command.name)) {
        continue;
      }
      const key = commandNameKey(command.name);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      commands.push(command);
    }
    return commands;
  }
  commands.push(...scanClaudeGlobalCommandsFromDisk(seen));
  return commands;
}
