import type { AcpRuntimeManager } from '../acp/acp-runtime-manager';
interface ClaudeCompactionClient {
  isCompactingActive: () => boolean;
  startCompaction: () => void;
  endCompaction: () => void;
}

interface ThinkingBudgetClient {
  setMaxThinkingTokens: (tokens: number | null) => Promise<void>;
}

export function isClaudeCompactionClient(value: unknown): value is ClaudeCompactionClient {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<ClaudeCompactionClient>;
  return (
    typeof candidate.isCompactingActive === 'function' &&
    typeof candidate.startCompaction === 'function' &&
    typeof candidate.endCompaction === 'function'
  );
}

export function isThinkingBudgetClient(value: unknown): value is ThinkingBudgetClient {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<ThinkingBudgetClient>;
  return typeof candidate.setMaxThinkingTokens === 'function';
}

export function getRequeueReason(
  runtime: Pick<AcpRuntimeManager, 'isSessionPromptInFlight' | 'isSessionRunning'>,
  dbSessionId: string,
  client?: unknown
): 'working' | 'compacting' | 'stopped' | null {
  if (runtime.isSessionPromptInFlight(dbSessionId)) {
    return 'working';
  }
  if (!runtime.isSessionRunning(dbSessionId)) {
    return 'stopped';
  }
  if (isClaudeCompactionClient(client) && client.isCompactingActive()) {
    return 'compacting';
  }
  return null;
}

export function isCompactCommandText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '/compact' || trimmed.startsWith('/compact ');
}
