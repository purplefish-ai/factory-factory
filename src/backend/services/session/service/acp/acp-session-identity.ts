/** Legacy Factory Factory IDs remain durable; adapters receive native IDs. */
export function toAcpSessionId(provider: string, providerSessionId: string): string {
  return provider === 'CODEX' && providerSessionId.startsWith('sess_')
    ? providerSessionId.slice('sess_'.length)
    : providerSessionId;
}
