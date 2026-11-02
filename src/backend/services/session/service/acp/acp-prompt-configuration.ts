import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import type { AcpProvider } from './types';
/** In-process proof that public configuration mutations are queued behind this prompt. */
export interface PromptConfigurationPermit {
  readonly provider: AcpProvider;
  readonly providerSessionId: string;
  configOptions(): SessionConfigOption[];
  assertCurrent(): void;
}
