import type { WorkspaceSessionRuntimeSummary } from '@/components/workspace/session-tab-runtime';
import type { ChatMessage } from '@/lib/chat-protocol';
import type { SessionRuntimeState } from '@/shared/session-runtime';

type MessageSourceOnly = Pick<ChatMessage, 'source'>;

interface DismissibleInitBanner {
  showDismiss?: boolean;
}

export function shouldFetchArchiveGitStatus(
  archiveDialogOpen: boolean,
  worktreePath: string | null | undefined
): boolean {
  return archiveDialogOpen && Boolean(worktreePath);
}

export function getVisibleInitBanner<T extends DismissibleInitBanner>(
  banner: T | null | undefined,
  setupWarningDismissed: boolean | null
): T | null {
  if (!banner || (banner.showDismiss === true && setupWarningDismissed !== false)) {
    return null;
  }

  return banner;
}

export interface SessionForRuntimeOverlay {
  id: string;
  name: string | null;
  workflow: string | null;
  model: string | null;
  provider?: WorkspaceSessionRuntimeSummary['provider'];
  status: WorkspaceSessionRuntimeSummary['persistedStatus'];
}

export interface BuildSessionSummariesOptions {
  workspaceSummaries: WorkspaceSessionRuntimeSummary[] | undefined;
  sessions: SessionForRuntimeOverlay[] | undefined;
  selectedSessionId: string | null;
  liveRuntime: SessionRuntimeState;
  /** The session the live runtime was hydrated for (null before hydration). */
  runtimeSessionId: string | null;
  chatConnected: boolean;
}

/**
 * Builds the per-session runtime summary map from a single reconciled source:
 * snapshot `sessionSummaries` are the base for every session, and the chat
 * WebSocket runtime overlays only the currently selected session while the
 * chat socket is connected (it is the direct authority for that session).
 * The overlay additionally requires the runtime to have been hydrated for
 * the selected session — during a session switch the reducer still holds the
 * previous session's runtime for a render or two, and overlaying it would
 * paint the wrong session's status onto the new tab. All other sessions stay
 * on snapshot data, which the /snapshots channel keeps live — no timestamp
 * reconciliation needed.
 */
export function buildSessionSummariesById(
  options: BuildSessionSummariesOptions
): Map<string, WorkspaceSessionRuntimeSummary> {
  const { workspaceSummaries, sessions, selectedSessionId, liveRuntime, chatConnected } = options;

  const summaries = new Map(
    (workspaceSummaries ?? []).map((summary) => [summary.sessionId, summary])
  );

  if (!(selectedSessionId && chatConnected && options.runtimeSessionId === selectedSessionId)) {
    return summaries;
  }

  const session = sessions?.find((s) => s.id === selectedSessionId);
  if (!session) {
    return summaries;
  }

  const existing = summaries.get(selectedSessionId);
  summaries.set(selectedSessionId, {
    sessionId: selectedSessionId,
    name: existing?.name ?? session.name ?? null,
    workflow: existing?.workflow ?? session.workflow ?? null,
    model: existing?.model ?? session.model ?? null,
    provider: existing?.provider ?? session.provider,
    persistedStatus: existing?.persistedStatus ?? session.status,
    runtimePhase: liveRuntime.phase,
    processState: liveRuntime.processState,
    activity: liveRuntime.activity,
    updatedAt: liveRuntime.updatedAt,
    lastExit: liveRuntime.lastExit ?? existing?.lastExit ?? null,
    errorMessage: liveRuntime.errorMessage ?? existing?.errorMessage ?? null,
  });

  return summaries;
}

export function hasUserMessageWithoutAgentMessage(messages: readonly MessageSourceOnly[]): boolean {
  let hasUserMessage = false;

  for (const message of messages) {
    if (message.source === 'agent') {
      return false;
    }
    if (message.source === 'user') {
      hasUserMessage = true;
    }
  }

  return hasUserMessage;
}
