import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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

interface LogStreamBuffer {
  streamKey: string;
  output: RollingOutputBuffer;
}

interface PendingOutputFlush {
  streamBuffer: LogStreamBuffer;
  timeoutId: ReturnType<typeof setTimeout>;
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
  const pendingFlushRef = useRef<PendingOutputFlush | null>(null);
  const streamKey = `${endpoint}:${workspaceId}`;
  const streamBuffer = useMemo<LogStreamBuffer>(
    () => ({
      streamKey,
      output: new RollingOutputBuffer(LOG_ROLLING_OUTPUT_OPTIONS),
    }),
    [streamKey]
  );
  const committedStreamBufferRef = useRef(streamBuffer);

  const url = buildWebSocketUrl(endpoint, { workspaceId });

  const cancelPendingFlush = useCallback(() => {
    if (pendingFlushRef.current === null) {
      return;
    }
    clearTimeout(pendingFlushRef.current.timeoutId);
    pendingFlushRef.current = null;
  }, []);

  const scheduleVisibleFlush = useCallback(() => {
    if (
      committedStreamBufferRef.current !== streamBuffer ||
      !visibleRef.current ||
      pendingFlushRef.current !== null
    ) {
      return;
    }
    const timeoutId = setTimeout(() => {
      if (
        pendingFlushRef.current?.timeoutId !== timeoutId ||
        pendingFlushRef.current.streamBuffer !== streamBuffer
      ) {
        return;
      }
      pendingFlushRef.current = null;
      if (committedStreamBufferRef.current === streamBuffer && visibleRef.current) {
        setOutput(streamBuffer.output.toString());
      }
    }, LOG_OUTPUT_FLUSH_INTERVAL_MS);
    pendingFlushRef.current = { streamBuffer, timeoutId };
  }, [streamBuffer]);

  const appendOutput = useCallback(
    (next: string) => {
      if (committedStreamBufferRef.current !== streamBuffer) {
        return;
      }
      streamBuffer.output.append(next);
      scheduleVisibleFlush();
    },
    [scheduleVisibleFlush, streamBuffer]
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
    if (committedStreamBufferRef.current !== streamBuffer) {
      return;
    }
    setHasDisconnected(false);
    appendOutput(streamBuffer.output.toString() ? 'Reconnected!\n\n' : 'Connected!\n\n');
  }, [appendOutput, streamBuffer]);

  const handleDisconnected = useCallback(() => {
    if (committedStreamBufferRef.current !== streamBuffer) {
      return;
    }
    setHasDisconnected(true);
    appendOutput('Disconnected. Reconnecting...\n');
  }, [appendOutput, streamBuffer]);

  useLayoutEffect(() => {
    const bufferChanged = committedStreamBufferRef.current !== streamBuffer;
    committedStreamBufferRef.current = streamBuffer;
    visibleRef.current = isVisible;
    cancelPendingFlush();

    if (bufferChanged) {
      setHasDisconnected(false);
    }
    if (isVisible) {
      setOutput(streamBuffer.output.toString());
    } else if (bufferChanged) {
      setOutput('');
    }
  }, [cancelPendingFlush, isVisible, streamBuffer]);

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
