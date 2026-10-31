import type { SessionProvider } from '@/shared/core/enums';

const CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable']);

export const DEFAULT_SESSION_MODEL_BY_PROVIDER: Record<SessionProvider, string> = {
  CLAUDE: 'sonnet',
  CODEX: 'default',
};

function isClaudeModel(model: string): boolean {
  const lower = model.toLowerCase();
  return CLAUDE_MODEL_ALIASES.has(lower.replace(/\[1m\]$/, '')) || lower.startsWith('claude-');
}

function isLikelyCodexModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.startsWith('gpt-') ||
    lower === 'o1' ||
    lower.startsWith('o1-') ||
    lower === 'o3' ||
    lower.startsWith('o3-') ||
    lower === 'o4' ||
    lower.startsWith('o4-')
  );
}

/**
 * Keep custom model strings flexible, but prevent obvious cross-provider leakage.
 */
export function normalizeSessionModelForProvider(
  model: string | null | undefined,
  provider: SessionProvider
): string | undefined {
  const normalized = model?.trim();
  if (!normalized) {
    return undefined;
  }

  if (provider === 'CODEX') {
    if (isClaudeModel(normalized)) {
      return undefined;
    }
    return normalized;
  }

  if (isLikelyCodexModel(normalized)) {
    return undefined;
  }

  const lower = normalized.toLowerCase();
  if (CLAUDE_MODEL_ALIASES.has(lower.replace(/\[1m\]$/, ''))) {
    return lower;
  }

  return normalized;
}
