/**
 * Shared constants for backend utility libraries.
 */
export const LIB_LIMITS = Object.freeze({
  maxFileReadBytes: 1024 * 1024,
  shellDefaultMaxBufferBytes: 10 * 1024 * 1024,
  osascriptEscapedMaxChars: 200,
} as const);
