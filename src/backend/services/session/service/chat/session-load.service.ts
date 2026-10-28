import type { ResolvedSessionConfigProjection } from '@/backend/services/session/service/lifecycle/session-config-projection';
import type { ProviderHistorySession } from '@/backend/services/session/service/lifecycle/session-provider-history-hydrator';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { finalizeInterruptedTranscriptToolCalls } from '@/backend/services/session/service/store/session-tool-call-recovery';
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
    const resolved = await this.deps.config.getSessionConfigProjection(sessionId);
    const { capabilities, configOptions } = resolved.currentProjection();
    this.deps.domain.emitDelta(sessionId, { type: 'chat_capabilities', capabilities });
    if (configOptions.length > 0) {
      this.deps.domain.emitDelta(sessionId, { type: 'config_options_update', configOptions });
    }
    const cached = await this.deps.getCachedCommands(provider);
    const slashCommands =
      provider === 'CLAUDE'
        ? buildClaudeSlashCommandsForLoad(cached, worktreePath)
        : (cached ?? []);
    this.deps.domain.emitDelta(sessionId, { type: 'slash_commands', slashCommands });
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
