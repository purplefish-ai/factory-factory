import type { AcpConfigOption } from '@/client/features/chat/reducer';
import type { WorkspaceSessionRuntimeSummary } from '@/client/features/workspace/session-tab-runtime';
import type { ChatSettings, ChatMessage } from '@/lib/chat-protocol';
import {
  resolveExplicitSessionProvider,
  type NewSessionProviderSelection,
} from '@/lib/session-provider-selection';
import type { ChatProvider } from '@/shared/chat-capabilities';
import type { SessionLaunchSettings } from '@/shared/session-launch';
import type { SessionRuntimeState } from '@/shared/session-runtime';

type MessageSourceOnly = Pick<ChatMessage, 'source'>;

interface DismissibleInitBanner {
  showDismiss?: boolean;
}

export function isProviderSubagentSessionReady(selectedSessionId: string | null): boolean {
  return Boolean(selectedSessionId);
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

interface NewSessionDefaultsOptions {
  selectedSessionId: string | null;
  runtimeSessionId: string | null;
  capabilitiesLoaded: boolean;
  provider: ChatProvider;
  settings: ChatSettings;
  configOptions?: AcpConfigOption[] | null;
  defaultProvider: NewSessionProviderSelection | undefined;
  workspaceReady: boolean;
}

/** Copy only settings hydrated for the selected conversation, never bootstrap or previous values. */
export function getNewSessionDefaults(options: NewSessionDefaultsOptions): {
  provider: ChatProvider | null;
  ready: boolean;
  unavailableReason?: string;
  creationDefaults: SessionLaunchSettings & { provider?: ChatProvider; model?: string };
} {
  const {
    selectedSessionId,
    runtimeSessionId,
    capabilitiesLoaded,
    provider,
    settings,
    configOptions,
    defaultProvider,
    workspaceReady,
  } = options;
  const ready =
    workspaceReady &&
    (!selectedSessionId ||
      (runtimeSessionId === selectedSessionId && capabilitiesLoaded && configOptions != null));
  if (!ready) {
    return {
      provider: null,
      ready: false,
      unavailableReason: 'Loading current session settings',
      creationDefaults: {},
    };
  }
  if (!selectedSessionId) {
    const fallbackProvider = resolveExplicitSessionProvider(defaultProvider ?? 'WORKSPACE_DEFAULT');
    return {
      provider: fallbackProvider ?? null,
      ready: true,
      unavailableReason: undefined,
      creationDefaults: { provider: fallbackProvider },
    };
  }
  const reasoning = configOptions?.find(
    (option) =>
      option.category === 'thought_level' ||
      option.category === 'reasoning' ||
      option.id === 'reasoning_effort' ||
      option.id === 'thought_level'
  );
  const planningKind = provider === 'CODEX' ? 'collaboration_mode' : 'mode';
  const planning = configOptions?.find(
    (option) => option.id === planningKind || option.category === planningKind
  );
  return {
    provider,
    ready: true,
    unavailableReason: undefined,
    creationDefaults: {
      provider,
      model: settings.selectedModel,
      reasoningEffort: reasoning?.currentValue ?? settings.reasoningEffort,
      planModeEnabled: planning ? planning.currentValue === 'plan' : settings.planModeEnabled,
    },
  };
}
