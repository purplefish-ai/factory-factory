import type { AcpClientFactory } from './acp-client-factory';
import type { AcpProcessHandle } from './acp-process-handle';

export type AcpRuntimeSupervisorDependencies = {
  clientFactory: Pick<AcpClientFactory, 'createClient'>;
  cancelPrompt(sessionId: string, handle: AcpProcessHandle): Promise<boolean>;
};
