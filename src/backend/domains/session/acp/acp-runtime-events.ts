import type { RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk';

export type AcpSessionUpdateEvent = {
  type: 'acp_session_update';
  update: SessionNotification['update'];
};

export type AcpPermissionRequestEvent = {
  type: 'acp_permission_request';
  requestId: string;
  params: RequestPermissionRequest;
};

export type AcpRuntimeEvent = AcpSessionUpdateEvent | AcpPermissionRequestEvent;
