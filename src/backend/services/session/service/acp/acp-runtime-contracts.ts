import type { AcpProcessHandle } from './acp-process-handle';
import type { AcpRuntimePurpose } from './acp-runtime-events';

export type AcpRuntimeMetadata = {
  incarnationId: string;
  purpose: AcpRuntimePurpose;
  installed: boolean;
};

export type AcpRuntimeContext = { workspaceId: string; workingDir: string };

export type AcpStartupSignal = {
  promise: Promise<never>;
  dispose(): void;
};

export type AcpRuntimeCreatedCallback = (
  sessionId: string,
  client: AcpProcessHandle,
  context: AcpRuntimeContext
) => void;
