import { useCallback } from 'react';
import { z } from 'zod';
import { useWebSocketTransport } from '@/hooks/use-websocket-transport';
import { buildWebSocketUrl } from '@/lib/websocket-config';

const TerminalDescriptorSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  outputBuffer: z.string().optional(),
});

const TerminalMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('output'),
    data: z.string().optional(),
    terminalId: z.string().optional(),
  }),
  z.object({
    type: z.literal('created'),
    terminalId: z.string().optional(),
  }),
  z.object({
    type: z.literal('exit'),
    terminalId: z.string().optional(),
    exitCode: z.number().optional(),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal('terminal_list'),
    terminals: z.array(TerminalDescriptorSchema).optional(),
  }),
]);

type TerminalMessage = z.infer<typeof TerminalMessageSchema>;

// =============================================================================
// Types
// =============================================================================

interface UseTerminalWebSocketOptions {
  workspaceId: string;
  onOutput?: (terminalId: string, data: string) => void;
  onCreated?: (terminalId: string) => void;
  onExit?: (terminalId: string, exitCode: number) => void;
  onError?: (message: string) => void;
  onTerminalList?: (
    terminals: Array<{ id: string; createdAt: string; outputBuffer?: string }>
  ) => void;
}

interface UseTerminalWebSocketReturn {
  connected: boolean;
  create: (cols?: number, rows?: number) => void;
  sendInput: (terminalId: string, data: string) => void;
  resize: (terminalId: string, cols: number, rows: number) => void;
  destroy: (terminalId: string) => void;
  setActive: (terminalId: string) => void;
}

// =============================================================================
// Message Handler
// =============================================================================

interface MessageHandlerCallbacks {
  onOutput?: (terminalId: string, data: string) => void;
  onCreated?: (terminalId: string) => void;
  onExit?: (terminalId: string, exitCode: number) => void;
  onError?: (message: string) => void;
  onTerminalList?: (
    terminals: Array<{ id: string; createdAt: string; outputBuffer?: string }>
  ) => void;
}

function handleTerminalMessage(message: TerminalMessage, callbacks: MessageHandlerCallbacks): void {
  const { onOutput, onCreated, onExit, onError, onTerminalList } = callbacks;

  switch (message.type) {
    case 'output':
      if (message.terminalId && message.data) {
        onOutput?.(message.terminalId, message.data);
      }
      break;
    case 'created':
      if (message.terminalId) {
        onCreated?.(message.terminalId);
      }
      break;
    case 'exit':
      if (message.terminalId && message.exitCode !== undefined) {
        onExit?.(message.terminalId, message.exitCode);
      }
      break;
    case 'error':
      if (message.message) {
        onError?.(message.message);
      }
      break;
    case 'terminal_list':
      if (message.terminals) {
        onTerminalList?.(message.terminals);
      }
      break;
  }
}

// =============================================================================
// Hook
// =============================================================================

export function useTerminalWebSocket({
  workspaceId,
  onOutput,
  onCreated,
  onExit,
  onError,
  onTerminalList,
}: UseTerminalWebSocketOptions): UseTerminalWebSocketReturn {
  const url = buildWebSocketUrl('/terminal', { workspaceId });

  const handleMessage = useCallback(
    (data: unknown) => {
      const parsed = TerminalMessageSchema.safeParse(data);
      if (!parsed.success) {
        return;
      }
      const message: TerminalMessage = parsed.data;
      handleTerminalMessage(message, { onOutput, onCreated, onExit, onError, onTerminalList });
    },
    [onOutput, onCreated, onExit, onError, onTerminalList]
  );

  const { connected, send } = useWebSocketTransport({
    url,
    onMessage: handleMessage,
    queuePolicy: 'drop',
  });

  const create = useCallback(
    (cols = 80, rows = 24) => {
      send({ type: 'create', cols, rows });
    },
    [send]
  );

  const sendInput = useCallback(
    (terminalId: string, data: string) => {
      send({ type: 'input', terminalId, data });
    },
    [send]
  );

  const resize = useCallback(
    (terminalId: string, cols: number, rows: number) => {
      send({ type: 'resize', terminalId, cols, rows });
    },
    [send]
  );

  const destroy = useCallback(
    (terminalId: string) => {
      send({ type: 'destroy', terminalId });
    },
    [send]
  );

  const setActive = useCallback(
    (terminalId: string) => {
      send({ type: 'set_active', terminalId });
    },
    [send]
  );

  return {
    connected,
    create,
    sendInput,
    resize,
    destroy,
    setActive,
  };
}
