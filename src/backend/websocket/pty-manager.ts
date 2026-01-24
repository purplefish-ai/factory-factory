import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { createLogger } from '../services/index.js';
import { TERMINAL_LIMITS, terminalMessageSchema } from './schemas.js';

const logger = createLogger('pty-manager');

// Connection limits
const MAX_CONNECTIONS_PER_SESSION = 5;
const MAX_TOTAL_CONNECTIONS = 50;

interface PtyConnection {
  pty: pty.IPty;
  sessionName: string;
  ws: WebSocket;
  createdAt: Date;
}

// Map of WebSocket to PTY connection
const connections = new Map<WebSocket, PtyConnection>();

// Map of session name to connection count
const sessionConnectionCounts = new Map<string, number>();

/**
 * Get connection statistics
 */
export function getStats(): {
  totalConnections: number;
  sessionCounts: Record<string, number>;
} {
  return {
    totalConnections: connections.size,
    sessionCounts: Object.fromEntries(sessionConnectionCounts),
  };
}

/**
 * Attach a WebSocket to a tmux session via PTY
 */
export function attach(
  sessionName: string,
  ws: WebSocket,
  cols: number,
  rows: number
): { success: boolean; error?: string } {
  // Check total connection limit
  if (connections.size >= MAX_TOTAL_CONNECTIONS) {
    logger.warn('Total connection limit reached', { totalConnections: connections.size });
    return { success: false, error: 'Server connection limit reached' };
  }

  // Check per-session connection limit
  const sessionCount = sessionConnectionCounts.get(sessionName) ?? 0;
  if (sessionCount >= MAX_CONNECTIONS_PER_SESSION) {
    logger.warn('Session connection limit reached', { sessionName, sessionCount });
    return { success: false, error: 'Session connection limit reached' };
  }

  // Clamp dimensions to valid range
  const clampedCols = Math.max(TERMINAL_LIMITS.MIN_COLS, Math.min(TERMINAL_LIMITS.MAX_COLS, cols));
  const clampedRows = Math.max(TERMINAL_LIMITS.MIN_ROWS, Math.min(TERMINAL_LIMITS.MAX_ROWS, rows));

  try {
    // Spawn PTY attached to tmux session
    const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', sessionName], {
      name: 'xterm-256color',
      cols: clampedCols,
      rows: clampedRows,
      cwd: process.env.HOME || '/',
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      },
    });

    // Store connection
    const connection: PtyConnection = {
      pty: ptyProcess,
      sessionName,
      ws,
      createdAt: new Date(),
    };
    connections.set(ws, connection);

    // Update session connection count
    sessionConnectionCounts.set(sessionName, sessionCount + 1);

    logger.info('PTY attached to tmux session', {
      sessionName,
      cols: clampedCols,
      rows: clampedRows,
      pid: ptyProcess.pid,
    });

    // Forward PTY output to WebSocket
    ptyProcess.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'output', data }));
        } catch (error) {
          logger.error('Failed to send output to WebSocket', error as Error);
        }
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      logger.info('PTY process exited', { sessionName, exitCode, signal });

      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
        } catch {
          // Ignore send errors on exit
        }
      }

      // Clean up the connection
      cleanup(ws);
    });

    return { success: true };
  } catch (error) {
    logger.error('Failed to spawn PTY', error as Error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to spawn PTY',
    };
  }
}

/**
 * Handle incoming WebSocket message
 */
export function handleMessage(ws: WebSocket, rawMessage: string): void {
  const connection = connections.get(ws);
  if (!connection) {
    logger.warn('Received message for unknown connection');
    return;
  }

  try {
    const message = terminalMessageSchema.parse(JSON.parse(rawMessage));

    switch (message.type) {
      case 'input':
        // Forward input to PTY
        connection.pty.write(message.data);
        break;

      case 'resize': {
        // Resize PTY
        const clampedCols = Math.max(
          TERMINAL_LIMITS.MIN_COLS,
          Math.min(TERMINAL_LIMITS.MAX_COLS, message.cols)
        );
        const clampedRows = Math.max(
          TERMINAL_LIMITS.MIN_ROWS,
          Math.min(TERMINAL_LIMITS.MAX_ROWS, message.rows)
        );

        connection.pty.resize(clampedCols, clampedRows);
        logger.debug('PTY resized', {
          sessionName: connection.sessionName,
          cols: clampedCols,
          rows: clampedRows,
        });
        break;
      }
    }
  } catch (error) {
    logger.warn('Invalid message received', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    // Send error to client
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Invalid message format',
          })
        );
      } catch {
        // Ignore send errors
      }
    }
  }
}

/**
 * Clean up a WebSocket connection
 */
export function cleanup(ws: WebSocket): void {
  const connection = connections.get(ws);
  if (!connection) {
    return;
  }

  const { sessionName, pty: ptyProcess } = connection;

  // Kill PTY process if still running
  try {
    ptyProcess.kill();
  } catch {
    // Process may already be dead
  }

  // Remove from connections map
  connections.delete(ws);

  // Update session connection count
  const sessionCount = sessionConnectionCounts.get(sessionName) ?? 0;
  if (sessionCount <= 1) {
    sessionConnectionCounts.delete(sessionName);
  } else {
    sessionConnectionCounts.set(sessionName, sessionCount - 1);
  }

  logger.info('Connection cleaned up', { sessionName });
}

/**
 * Clean up all connections (for graceful shutdown)
 */
export function cleanupAll(): void {
  logger.info('Cleaning up all PTY connections', { count: connections.size });

  for (const ws of connections.keys()) {
    cleanup(ws);
  }
}
