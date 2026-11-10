import {
  RollingOutputBuffer,
  TERMINAL_OUTPUT_MAX_CHARS,
  TERMINAL_TRUNCATION_MARKER,
} from './rolling-output';

export type TerminalOutputEvent =
  | { type: 'append'; data: string }
  | { type: 'reset'; output: string };

export type TerminalOutputListener = (event: TerminalOutputEvent) => void;

function createTerminalBuffer(output: string): RollingOutputBuffer {
  const buffer = new RollingOutputBuffer({
    maxChars: TERMINAL_OUTPUT_MAX_CHARS,
    truncationMarker: TERMINAL_TRUNCATION_MARKER,
  });
  buffer.append(output);
  return buffer;
}

/**
 * Terminal output kept outside React state.
 *
 * Writers append PTY chunks; a mounted terminal subscribes and writes each
 * chunk straight into xterm, which keeps its own scrollback. The bounded
 * rolling snapshot is only read to replay output into a terminal when it
 * mounts, remounts or switches streams, so appending never re-renders anything
 * and never rewrites the whole window once it reaches the cap.
 */
export class TerminalOutputStream {
  private buffer: RollingOutputBuffer;
  private readonly listeners = new Set<TerminalOutputListener>();

  constructor(initialOutput = '') {
    this.buffer = createTerminalBuffer(initialOutput);
  }

  /** The retained rolling window, for replaying into a newly mounted terminal. */
  snapshot(): string {
    return this.buffer.toString();
  }

  append(data: string): void {
    if (data.length === 0) {
      return;
    }
    this.buffer.append(data);
    this.emit({ type: 'append', data });
  }

  /**
   * Replaces the retained output, e.g. with the server's buffer after a
   * reconnect. When the replacement only extends the current window, listeners
   * receive just the new suffix; otherwise they receive a reset.
   */
  replace(output: string): void {
    const current = this.buffer.toString();
    this.buffer = createTerminalBuffer(output);
    const next = this.buffer.toString();
    if (next === current) {
      return;
    }
    if (next.startsWith(current)) {
      this.emit({ type: 'append', data: next.slice(current.length) });
      return;
    }
    this.emit({ type: 'reset', output: next });
  }

  subscribe(listener: TerminalOutputListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: TerminalOutputEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
