/**
 * Shared constants for backend utility libraries.
 */
export const LIB_LIMITS = Object.freeze({
  maxFileReadBytes: 1024 * 1024,
  shellDefaultMaxBufferBytes: 10 * 1024 * 1024,
  osascriptEscapedMaxChars: 200,
} as const);

/**
 * Factory Factory signature for PRs created by agents.
 */
export const FACTORY_SIGNATURE = '🏭 Forged in [Factory Factory](https://factoryfactory.ai)';
