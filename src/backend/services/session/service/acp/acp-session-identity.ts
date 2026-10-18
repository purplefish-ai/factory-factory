import type { AcpProvider } from './types';

export function normalizeCodexSessionId(providerSessionId: string): string {
  return providerSessionId.startsWith('sess_')
    ? providerSessionId.slice('sess_'.length)
    : providerSessionId;
}

/** Legacy Factory Factory IDs remain durable; adapters receive native IDs. */
export function toAcpSessionId(provider: AcpProvider, providerSessionId: string): string {
  return provider === 'CODEX' ? normalizeCodexSessionId(providerSessionId) : providerSessionId;
}
