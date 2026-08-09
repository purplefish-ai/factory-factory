import type { RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk';
import type { SubagentsChangedParams } from '@/shared/acp-protocol/subagents';

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

export type AcpRuntimeEvent =
  | AcpSessionUpdateEvent
  | AcpPermissionRequestEvent
  | AcpSubagentsChangedEvent;
