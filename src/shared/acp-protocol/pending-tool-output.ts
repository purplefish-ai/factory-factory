import type { ToolResultContentValue } from './protocol';

// Enough for a 10 MiB screenshot encoded in base64, shared across pending calls.
const MAX_PENDING_OUTPUT_CHARS = 16 * 1024 * 1024;
const MAX_PENDING_OUTPUT_CALLS = 1024;

type Output = { content?: ToolResultContentValue; rawOutput?: string };
type Entry = Output & { sessionId: string; size: number };

function contentSize(content: ToolResultContentValue | undefined): number {
  if (!Array.isArray(content)) {
    return content?.length ?? 0;
  }
  // Charge for each item as well as its strings so many short items are bounded.
  return content.reduce(
    (total, item) =>
      total +
      64 +
      (item.type === 'text'
        ? item.text.length
        : (item.source.type === 'base64' ? item.source.data.length : item.source.id.length) +
          item.source.media_type.length),
    0
  );
}

export class PendingToolOutput {
  private readonly entries = new Map<string, Entry>();
  private size = 0;

  take(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.size -= entry.size;
    }
    return entry;
  }

  patch(key: string, sessionId: string, patch: Output): void {
    const previous = this.take(key);
    let content = patch.content ?? previous?.content;
    let rawOutput = patch.rawOutput ?? previous?.rawOutput;
    let chars = contentSize(content);
    if (chars > MAX_PENDING_OUTPUT_CHARS) {
      content = undefined;
      chars = 0;
    }
    // Prefer canonical content when the two fields together cannot fit.
    if (chars + (rawOutput?.length ?? 0) > MAX_PENDING_OUTPUT_CHARS) {
      rawOutput = undefined;
    }
    const size = chars + (rawOutput?.length ?? 0);
    if (size === 0) {
      return;
    }
    this.entries.set(key, { sessionId, content, rawOutput, size });
    this.size += size;
    for (const oldest of this.entries.keys()) {
      if (this.size <= MAX_PENDING_OUTPUT_CHARS && this.entries.size <= MAX_PENDING_OUTPUT_CALLS) {
        break;
      }
      this.take(oldest);
    }
  }

  clearSession(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.sessionId === sessionId) {
        this.take(key);
      }
    }
  }
}
