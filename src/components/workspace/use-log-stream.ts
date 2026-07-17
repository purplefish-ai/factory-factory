import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useWebSocketChannel } from '@/hooks/use-websocket-channel';
import { buildWebSocketUrl } from '@/lib/websocket-config';
import {
  RollingOutputBuffer,
  WORKSPACE_LOG_OUTPUT_MAX_CHARS,
  WORKSPACE_LOG_TRUNCATION_MARKER,
} from './rolling-output';

const LogStreamMessageSchema = z.object({
  type: z.literal('output'),
  data: z.string().optional(),
});

const LOG_ROLLING_OUTPUT_OPTIONS = {
  maxChars: WORKSPACE_LOG_OUTPUT_MAX_CHARS,
  truncationMarker: WORKSPACE_LOG_TRUNCATION_MARKER,
};
const LOG_OUTPUT_FLUSH_INTERVAL_MS = 100;

// =============================================================================
// Types
// =============================================================================

export type LogStreamEndpoint = '/dev-logs' | '/post-run-logs';

export interface UseLogStreamResult {
  connected: boolean;
  hasDisconnected: boolean;
  output: string;
  outputEndRef: React.RefObject<HTMLDivElement | null>;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook to manage a push-only log WebSocket connection (dev logs or post-run
 * logs). Returns connection status and output data for use in both the tab
 * indicator and the DevLogsPanel content.
 *
 * Note: The WebSocket connection remains active even when the corresponding
 * tab is not visible. This is intentional to:
 * 1. Show the connection status indicator in the tab bar
 * 2. Buffer log output so users don't miss messages while viewing Terminal
 *
 * Uses useWebSocketChannel for schema validation and automatic reconnection
 * with exponential backoff.
 */
export function useLogStream(
  endpoint: LogStreamEndpoint,
  workspaceId: string,
  isVisible: boolean
): UseLogStreamResult {
  const [output, setOutput] = useState<string>('');
  const [hasDisconnected, setHasDisconnected] = useState(false);
  const outputEndRef = useRef<HTMLDivElement | null>(null);
  const visibleRef = useRef(isVisible);
  const flushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presentedBufferRef = useRef<RollingOutputBuffer | null>(null);
  const streamBufferRef = useRef<{
    streamKey: string;
    buffer: RollingOutputBuffer;
  } | null>(null);
  const streamKey = `${endpoint}:${workspaceId}`;
  if (streamBufferRef.current?.streamKey !== streamKey) {
    streamBufferRef.current = {
      streamKey,
      buffer: new RollingOutputBuffer(LOG_ROLLING_OUTPUT_OPTIONS),
    };
  }
  const buffer = streamBufferRef.current.buffer;

  visibleRef.current = isVisible;

  const url = buildWebSocketUrl(endpoint, { workspaceId });

  const cancelPendingFlush = useCallback(() => {
    if (flushTimeoutRef.current === null) {
      return;
    }
    clearTimeout(flushTimeoutRef.current);
    flushTimeoutRef.current = null;
  }, []);

  const flushOutput = useCallback(() => {
    flushTimeoutRef.current = null;
    if (visibleRef.current) {
      setOutput(buffer.toString());
    }
  }, [buffer]);

  const scheduleVisibleFlush = useCallback(() => {
    if (!visibleRef.current || flushTimeoutRef.current !== null) {
      return;
    }
    flushTimeoutRef.current = setTimeout(flushOutput, LOG_OUTPUT_FLUSH_INTERVAL_MS);
  }, [flushOutput]);

  const appendOutput = useCallback(
    (next: string) => {
      buffer.append(next);
      scheduleVisibleFlush();
    },
    [buffer, scheduleVisibleFlush]
  );

  const handleMessage = useCallback(
    (message: z.infer<typeof LogStreamMessageSchema>) => {
      if (message.data) {
        appendOutput(message.data);
      }
    },
    [appendOutput]
  );

  const handleConnected = useCallback(() => {
    setHasDisconnected(false);
    appendOutput(buffer.toString() ? 'Reconnected!\n\n' : 'Connected!\n\n');
  }, [appendOutput, buffer]);

  const handleDisconnected = useCallback(() => {
    setHasDisconnected(true);
    appendOutput('Disconnected. Reconnecting...\n');
  }, [appendOutput]);

  useLayoutEffect(() => {
    const bufferChanged = presentedBufferRef.current !== buffer;
    presentedBufferRef.current = buffer;
    cancelPendingFlush();

    if (bufferChanged) {
      setHasDisconnected(false);
    }
    if (isVisible) {
      setOutput(buffer.toString());
    } else if (bufferChanged) {
      setOutput('');
    }
  }, [buffer, cancelPendingFlush, isVisible]);

  useEffect(
    () => () => {
      cancelPendingFlush();
    },
    [cancelPendingFlush]
  );

  useEffect(() => {
    if (!(isVisible && output)) {
      return;
    }

    const animationFrameId = requestAnimationFrame(() => {
      outputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    });
    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [isVisible, output]);

  const { connected } = useWebSocketChannel({
    url,
    schema: LogStreamMessageSchema,
    onMessage: handleMessage,
    onConnected: handleConnected,
    onDisconnected: handleDisconnected,
    queuePolicy: 'drop',
  });

  return { connected, hasDisconnected, output, outputEndRef };
}
