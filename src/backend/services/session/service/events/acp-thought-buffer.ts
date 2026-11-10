import type { SessionDeltaEvent } from '@/shared/acp-protocol';

type AgentMessageDelta = Extract<SessionDeltaEvent, { type: 'agent_message' }>;

type PendingThought = {
  index: number;
  text: string;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * Returns the thinking text of a plain translated thought chunk, or null for
 * anything else. Chunks carrying extra fields are left alone so merging never
 * drops data.
 */
function readThoughtChunk(delta: SessionDeltaEvent): { index: number; text: string } | null {
  if (delta.type !== 'agent_message' || Object.keys(delta).length !== 2) {
    return null;
  }
  const data = delta.data;
  if (data.type !== 'stream_event' || Object.keys(data).length !== 2) {
    return null;
  }
  const event = data.event;
  if (event?.type !== 'content_block_delta' || event.delta.type !== 'thinking_delta') {
    return null;
  }
  return { index: event.index, text: event.delta.thinking };
}

function thoughtDelta(index: number, text: string): AgentMessageDelta {
  return {
    type: 'agent_message',
    data: {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: text },
      },
    },
  };
}

/**
 * Merges consecutive thinking chunks for a session into one delta per interval.
 *
 * Providers stream reasoning a few tokens at a time; persisting and emitting
 * each chunk costs a transcript entry and a WebSocket message per token. The
 * client appends thinking deltas to the current thinking block, so a merged
 * delta renders the same. Callers must flush before handling any other delta
 * for the session so ordering is preserved.
 */
export class AcpThoughtBuffer {
  private readonly pending = new Map<string, PendingThought>();

  constructor(
    private readonly emit: (sessionId: string, delta: AgentMessageDelta) => void,
    private readonly intervalMs: number
  ) {}

  /** Buffers a thought chunk and returns true, or returns false for any other delta. */
  push(sessionId: string, delta: SessionDeltaEvent): boolean {
    const chunk = readThoughtChunk(delta);
    if (!chunk) {
      return false;
    }
    let pending = this.pending.get(sessionId);
    if (pending && pending.index !== chunk.index) {
      this.flush(sessionId);
      pending = undefined;
    }
    if (!pending) {
      pending = { index: chunk.index, text: '' };
      this.pending.set(sessionId, pending);
    }
    pending.text += chunk.text;
    if (!pending.timer) {
      const scheduled = pending;
      pending.timer = setTimeout(() => {
        scheduled.timer = undefined;
        if (this.pending.get(sessionId) === scheduled) {
          this.flush(sessionId);
        }
      }, this.intervalMs);
    }
    return true;
  }

  /** Emits any buffered thought for the session now. */
  flush(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending) {
      return;
    }
    this.pending.delete(sessionId);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    if (pending.text.length > 0) {
      this.emit(sessionId, thoughtDelta(pending.index, pending.text));
    }
  }
}
