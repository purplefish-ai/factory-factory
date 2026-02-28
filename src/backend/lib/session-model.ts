import type { SessionProvider } from '@prisma-gen/client';

const CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);

const DEFAULT_SESSION_MODEL_BY_PROVIDER: Record<SessionProvider, string> = {
  CLAUDE: 'sonnet',
  CODEX: 'default',
  OPENCODE: 'default',
};

function isClaudeModel(model: string): boolean {
  const lower = model.toLowerCase();
  return CLAUDE_MODEL_ALIASES.has(lower) || lower.startsWith('claude-');
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

  if (provider !== 'CLAUDE') {
    if (isClaudeModel(normalized)) {
      return undefined;
    }
    return normalized;
  }

  if (isLikelyCodexModel(normalized)) {
    return undefined;
  }

  const lower = normalized.toLowerCase();
  if (CLAUDE_MODEL_ALIASES.has(lower)) {
    return lower;
  }

  return normalized;
}

export function resolveSessionModelForProvider(
  model: string | null | undefined,
  provider: SessionProvider
): string {
  return (
    normalizeSessionModelForProvider(model, provider) ?? DEFAULT_SESSION_MODEL_BY_PROVIDER[provider]
  );
}
