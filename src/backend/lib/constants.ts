/**
 * Shared constants for backend utility libraries.
 */
export const LIB_LIMITS = Object.freeze({
  maxFileReadBytes: 1024 * 1024,
  shellDefaultMaxBufferBytes: 10 * 1024 * 1024,
  execCommandDefaultMaxBufferBytes: 10 * 1024 * 1024,
  execCommandDefaultTimeoutMs: 5 * 60 * 1000,
  osascriptEscapedMaxChars: 200,
} as const);

/**
 * Factory Factory signature for PRs created by agents.
 */
export { FACTORY_SIGNATURE } from '@/shared/issue-start-prompt';
