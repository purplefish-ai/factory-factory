/** Shared by the worker and source viewer, without loading any grammar on the UI thread. */
export const FILE_HIGHLIGHT_BLOCK_LINES = 128;
export const FILE_HIGHLIGHT_BLOCK_BYTES = 32_768;
export const FILE_HIGHLIGHT_BLOCK_TOKENS = 4096;

/** Cheap source-size preflight; the worker separately enforces the token budget. */
export function isFileBlockWithinByteBudget(content: string): boolean {
  if (content.length > FILE_HIGHLIGHT_BLOCK_BYTES) {
    return false;
  }
  // UTF-8 requires at most three bytes per UTF-16 code unit.
  if (content.length * 3 <= FILE_HIGHLIGHT_BLOCK_BYTES) {
    return true;
  }
  return new TextEncoder().encode(content).byteLength <= FILE_HIGHLIGHT_BLOCK_BYTES;
}
