import type { SessionProvider } from '@/shared/core/enums';

/**
 * Providers whose event classifier passed the live replay gate recorded in
 * `../testing/classifier-gate.json`. Production builds exclude `testing/`, so
 * this mirrors the record; a co-located test enforces that they agree.
 */
export const PROVEN_CLASSIFIER_PROVIDERS: readonly SessionProvider[] = ['CLAUDE', 'CODEX'];

export function isClassifierProven(provider: SessionProvider) {
  return PROVEN_CLASSIFIER_PROVIDERS.includes(provider);
}

/**
 * Whether a trigger with natural-language filters may be enabled. An inherited
 * provider (undefined) can resolve to any provider, so every one must be proven;
 * evaluation still rechecks the provider resolved for each event.
 */
export function semanticFilterSupported(provider: SessionProvider | undefined) {
  return provider
    ? isClassifierProven(provider)
    : isClassifierProven('CLAUDE') && isClassifierProven('CODEX');
}
