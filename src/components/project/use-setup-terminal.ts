import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  appendToRollingOutput,
  TERMINAL_OUTPUT_MAX_CHARS,
  TERMINAL_TRUNCATION_MARKER,
} from '@/components/workspace/rolling-output';
import { useWebSocketChannel } from '@/hooks/use-websocket-channel';
import { buildWebSocketUrl } from '@/lib/websocket-config';

const SetupTerminalMessageSchema = z.object({
  type: z.string(),
  data: z.string().optional(),
  message: z.string().optional(),
});

const RECONNECT_NOTE = '\r\n\x1b[33m[Connection lost — starting a new shell]\x1b[0m\r\n';

const TERMINAL_ROLLING_OUTPUT_OPTIONS = {
  maxChars: TERMINAL_OUTPUT_MAX_CHARS,
  truncationMarker: TERMINAL_TRUNCATION_MARKER,
};

export interface UseSetupTerminalResult {
  /** Whether the WebSocket is currently connected. */
  connected: boolean;
  /** Whether automatic reconnection has stopped; call reconnect() to retry. */
  gaveUp: boolean;
  /** Manually restart the connection after automatic retries gave up. */
  reconnect: () => void;
  /**
   * Whether the terminal should be rendered. Stays true across transient
   * disconnects (unlike `connected`) so the terminal doesn't vanish while
   * the transport reconnects.
   */
  showTerminal: boolean;
  /** Accumulated terminal output. */
  output: string;
  /** Forward keystrokes to the server-side PTY. */
  handleData: (data: string) => void;
  /** Report terminal size; also used for the create request on (re)connect. */
  handleResize: (cols: number, rows: number) => void;
}

/**
 * Connection logic for the setup terminal modal.
 *
 * Built on useWebSocketChannel, so a dropped connection reconnects with
 * exponential backoff. The server-side PTY dies with each connection, so
 * every (re)connect sends a fresh `create`; a note is appended to the output
 * on reconnects so users know the shell restarted.
 */
export function useSetupTerminal(open: boolean): UseSetupTerminalResult {
  const [output, setOutput] = useState('');
  const [showTerminal, setShowTerminal] = useState(false);
  const hasConnectedRef = useRef(false);
  const colsRef = useRef(80);
  const rowsRef = useRef(24);

  const handleMessage = useCallback((message: z.infer<typeof SetupTerminalMessageSchema>) => {
    if (message.type === 'output' && message.data) {
      setOutput((prev) =>
        appendToRollingOutput(prev, message.data ?? '', TERMINAL_ROLLING_OUTPUT_OPTIONS)
      );
    }
  }, []);

  const { connected, gaveUp, send, reconnect } = useWebSocketChannel({
    url: open ? buildWebSocketUrl('/setup-terminal', {}) : null,
    schema: SetupTerminalMessageSchema,
    onMessage: handleMessage,
    queuePolicy: 'drop',
  });

  // Reset when the modal closes so reopening starts a clean session.
  useEffect(() => {
    if (!open) {
      setOutput('');
      setShowTerminal(false);
      hasConnectedRef.current = false;
    }
  }, [open]);

  // Request a terminal on every (re)connect: the server-side PTY is
  // per-connection, so a reconnect needs a fresh create. The `open` guard
  // covers a connect landing in the same render pass as the modal closing,
  // which would otherwise undo the reset above.
  useEffect(() => {
    if (!(open && connected)) {
      return;
    }
    if (hasConnectedRef.current) {
      setOutput((prev) =>
        appendToRollingOutput(prev, RECONNECT_NOTE, TERMINAL_ROLLING_OUTPUT_OPTIONS)
      );
    }
    hasConnectedRef.current = true;
    setShowTerminal(true);
    send({ type: 'create', cols: colsRef.current, rows: rowsRef.current });
  }, [open, connected, send]);

  const handleData = useCallback(
    (data: string) => {
      send({ type: 'input', data });
    },
    [send]
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      colsRef.current = cols;
      rowsRef.current = rows;
      send({ type: 'resize', cols, rows });
    },
    [send]
  );

  return { connected, gaveUp, reconnect, showTerminal, output, handleData, handleResize };
}
