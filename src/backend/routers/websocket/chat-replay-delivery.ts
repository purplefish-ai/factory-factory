import type { WebSocket } from 'ws';
import {
  MAX_WEBSOCKET_STATEFUL_BACKLOG_BYTES,
  retireStatefulViewer,
  sendStateful,
} from '@/backend/lib/websocket-send';
import {
  MAX_REPLAY_FRAME_BYTES,
  type SessionReplayChunk,
} from '@/shared/acp-protocol/protocol/replay-frame-schema';

type Write = { message: string; written: () => void };
type Logger = { error(message: string, error: Error): void };

/** One bounded replay sequence, followed by at most one ordinary backlog budget. */
export class ChatReplayDelivery {
  private readonly frames: Write[] = [];
  private readonly tail: Write[] = [];
  private tailBytes = 0;
  private wireBytes = 0;
  private nextIndex = 0;
  private writing = false;
  private sealed = false;
  private cancelled = false;
  private readonly wireLimit: number;

  constructor(
    private readonly ws: WebSocket,
    readonly first: SessionReplayChunk,
    readonly loadRequestId: string | undefined,
    private readonly logger: Logger,
    private readonly complete: () => void,
    private readonly failed: () => void
  ) {
    // JSON event frames add envelopes; fragmented events add base64 overhead.
    // Both are bounded by twice the source plus 1 KiB per bounded wire frame.
    this.wireLimit = first.byteLength * 2 + first.total * 1024;
    ws.once('close', this.closed);
  }

  private readonly closed = () => {
    this.cancel();
    this.failed();
  };

  cancel(): void {
    this.cancelled = true;
    this.frames.length = 0;
    this.tail.length = 0;
    this.ws.off('close', this.closed);
  }

  append(frame: SessionReplayChunk, message: string, written: () => void): boolean {
    const bytes = Buffer.byteLength(message);
    if (this.cancelled) {
      return false;
    }
    if (
      frame.replayId !== this.first.replayId ||
      frame.total !== this.first.total ||
      frame.byteLength !== this.first.byteLength ||
      frame.index !== this.nextIndex ||
      bytes > MAX_REPLAY_FRAME_BYTES ||
      this.wireBytes + bytes > this.wireLimit
    ) {
      this.fail();
      return false;
    }
    this.wireBytes += bytes;
    this.nextIndex++;
    this.sealed = this.nextIndex === frame.total;
    this.frames.push({ message, written });
    this.pump();
    return true;
  }

  enqueueTail(message: string, written: () => void): boolean {
    if (this.cancelled) {
      return false;
    }
    this.tailBytes += Buffer.byteLength(message);
    if (this.tailBytes > MAX_WEBSOCKET_STATEFUL_BACKLOG_BYTES) {
      this.fail();
      return false;
    }
    this.tail.push({ message, written });
    return true;
  }

  private fail(): void {
    this.cancel();
    this.failed();
    retireStatefulViewer(this.ws, this.logger);
  }

  private pump(): void {
    if (this.cancelled || this.writing) {
      return;
    }
    const next = this.frames.shift();
    if (!next) {
      if (this.sealed) {
        this.finish();
      }
      return;
    }
    this.writing = true;
    const admitted = sendStateful(this.ws, next.message, this.logger, 'chat replay chunk', {
      onFlushed: (error) => {
        this.writing = false;
        if (this.cancelled) {
          return;
        }
        if (error) {
          this.fail();
          return;
        }
        next.written();
        // Avoid recursion with synchronous transport doubles or adapters.
        queueMicrotask(() => this.pump());
      },
    });
    if (!(admitted || this.cancelled)) {
      this.fail();
    }
  }

  private finish(): void {
    const tail = [...this.tail];
    this.cancel();
    this.complete();
    for (const item of tail) {
      sendStateful(this.ws, item.message, this.logger, 'chat session message', {
        onFlushed: (error) => {
          if (!error) {
            item.written();
          }
        },
      });
    }
  }
}
