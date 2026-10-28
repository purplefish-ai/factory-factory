import type {
  RequestPermissionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk/unstable';
import type { SubagentsChangedParams } from '@/shared/acp-protocol/subagents';
import type { AcpPermissionBridge } from './acp-permission-bridge';
import type { AcpSessionCreationOutcome } from './acp-session-creation-outcome';
export type { AcpSessionCreationOutcome } from './acp-session-creation-outcome';

export type AcpRuntimePurpose = 'active' | 'browse';

export type AcpRuntimeExitEvent = Readonly<{
  sessionId: string;
  exitCode: number | null;
  incarnationId: string;
  purpose: AcpRuntimePurpose;
  managed: boolean;
}>;

export type AcpRuntimeErrorEvent = Readonly<{
  sessionId: string;
  error: Error;
  incarnationId: string;
  purpose: AcpRuntimePurpose;
}>;

export type AcpProviderIdentityEvent = Readonly<{
  sessionId: string;
  providerSessionId: string;
  provider: 'CLAUDE' | 'CODEX';
  incarnationId: string;
  outcome: Extract<AcpSessionCreationOutcome, { kind: 'resume_fallback' }>;
  configOptions: import('@agentclientprotocol/sdk/unstable').SessionConfigOption[];
  /** Checked again after every asynchronous preparation, before durable reconciliation. */
  assertCurrent(): void;
}>;

/** Internal source capability for config observations from an installed pending candidate. */
export type AcpConfigObservationSource = Readonly<{
  handle: import('./acp-process-handle').AcpProcessHandle;
  isCurrent(): boolean;
}>;

export type AcpRuntimeEventHandlers = {
  /** Emitted only for this caller's newly installed candidate, never a reused runtime. */
  onRuntimeCreated?: (handle: import('./acp-process-handle').AcpProcessHandle) => void;
  onProviderIdentityRollover?: (event: AcpProviderIdentityEvent) => Promise<void>;
  onSessionId?: (sessionId: string, providerSessionId: string) => Promise<void>;
  onRuntimeExit?: (event: AcpRuntimeExitEvent) => Promise<void>;
  onRuntimeError?: (event: AcpRuntimeErrorEvent) => Promise<void> | void;
  onAcpEvent?: (
    sessionId: string,
    event: AcpRuntimeEvent,
    configSource?: AcpConfigObservationSource
  ) => void;
  onAcpLog?: (sessionId: string, payload: Record<string, unknown>) => void;
  /** Permission bridge to inject into AcpClientHandler for suspending requestPermission */
  permissionBridge?: AcpPermissionBridge;
};

export type AcpSessionUpdateEvent = {
  type: 'acp_session_update';
  update: SessionNotification['update'];
};

export type AcpPermissionRequestEvent = {
  type: 'acp_permission_request';
  /** Set only by the client-side elicitation bridge, never by tool arguments. */
  elicitation?: 'form' | 'url';
  requestId: string;
  params: RequestPermissionRequest;
};

export type AcpSubagentsChangedEvent = {
  type: 'acp_subagents_changed';
  subagentId: string;
  change: SubagentsChangedParams['change'];
};

export type AcpTaskStatusChangedEvent = {
  type: 'acp_task_status_changed';
  active: boolean;
};

export type AcpRuntimeEvent =
  | AcpSessionUpdateEvent
  | AcpPermissionRequestEvent
  | AcpSubagentsChangedEvent
  | AcpTaskStatusChangedEvent;
