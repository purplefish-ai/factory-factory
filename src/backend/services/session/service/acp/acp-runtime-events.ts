import type { RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk';
import type { SubagentsChangedParams } from '@/shared/acp-protocol/subagents';
import type { AcpPermissionBridge } from './acp-permission-bridge';

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

export type AcpRuntimeEventHandlers = {
  onSessionId?: (sessionId: string, providerSessionId: string) => Promise<void>;
  onRuntimeExit?: (event: AcpRuntimeExitEvent) => Promise<void>;
  onRuntimeError?: (event: AcpRuntimeErrorEvent) => Promise<void> | void;
  /** @deprecated Transitional adapter for callers that have not migrated to onRuntimeExit. */
  onExit?: (sessionId: string, code: number | null) => Promise<void>;
  onError?: (sessionId: string, error: Error) => Promise<void> | void;
  onAcpEvent?: (sessionId: string, event: AcpRuntimeEvent) => void;
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
