/**
 * Terminal WebSocket Handler
 *
 * Handles WebSocket connections for terminal sessions.
 * Manages PTY terminal creation, input/output, and lifecycle.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { terminalSessionAccessor } from '../../resource_accessors/terminal-session.accessor';
import { workspaceAccessor } from '../../resource_accessors/workspace.accessor';
import { createLogger } from '../../services/index';
import { terminalService } from '../../services/terminal.service';

const logger = createLogger('terminal-handler');

// ============================================================================
// Types
// ============================================================================

/**
 * Map of workspace ID to set of WebSocket connections
 */
export type TerminalConnectionsMap = Map<string, Set<WebSocket>>;

/**
 * Map of workspace ID to grace period timeout
 */
export type TerminalGracePeriodsMap = Map<string, NodeJS.Timeout>;

// ============================================================================
// State
// ============================================================================

export const TERMINAL_GRACE_PERIOD_MS = 30_000;

export const terminalConnections: TerminalConnectionsMap = new Map();
export const terminalGracePeriods: TerminalGracePeriodsMap = new Map();

const terminalListenerCleanup = new WeakMap<WebSocket, Map<string, (() => void)[]>>();

// ============================================================================
// Helper Functions
// ============================================================================

function cleanupTerminalListeners(ws: WebSocket): void {
  const cleanupMap = terminalListenerCleanup.get(ws);
  if (!cleanupMap) {
    return;
  }

  for (const [terminalId, unsubs] of cleanupMap) {
    logger.debug('Cleaning up listeners for terminal', { terminalId });
    for (const unsub of unsubs) {
      unsub();
    }
  }
  cleanupMap.clear();
}

// ============================================================================
// Terminal Upgrade Handler
// ============================================================================

export function handleTerminalUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
  wss: WebSocketServer,
  wsAliveMap: WeakMap<WebSocket, boolean>
): void {
  const workspaceId = url.searchParams.get('workspaceId');

  if (!workspaceId) {
    logger.warn('Terminal WebSocket missing workspaceId');
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Terminal WebSocket handler
  wss.handleUpgrade(request, socket, head, (ws) => {
    logger.info('Terminal WebSocket connection established', { workspaceId });

    wsAliveMap.set(ws, true);
    ws.on('pong', () => wsAliveMap.set(ws, true));

    const existingGracePeriod = terminalGracePeriods.get(workspaceId);
    if (existingGracePeriod) {
      clearTimeout(existingGracePeriod);
      terminalGracePeriods.delete(workspaceId);
      logger.info('Cancelled terminal grace period due to reconnection', { workspaceId });
    }

    if (!terminalConnections.has(workspaceId)) {
      terminalConnections.set(workspaceId, new Set());
    }
    terminalConnections.get(workspaceId)?.add(ws);

    terminalListenerCleanup.set(ws, new Map());

    logger.debug('Sending initial status message', { workspaceId });
    ws.send(JSON.stringify({ type: 'status', connected: true }));

    const existingTerminals = terminalService.getTerminalsForWorkspace(workspaceId);
    if (existingTerminals.length > 0) {
      logger.info('Sending existing terminal list for restoration', {
        workspaceId,
        terminalCount: existingTerminals.length,
      });

      ws.send(
        JSON.stringify({
          type: 'terminal_list',
          terminals: existingTerminals.map((t) => ({
            id: t.id,
            createdAt: t.createdAt.toISOString(),
            outputBuffer: t.outputBuffer,
          })),
        })
      );

      const existingConnections = terminalConnections.get(workspaceId);
      if (existingConnections) {
        for (const existingWs of existingConnections) {
          if (existingWs !== ws) {
            logger.debug('Cleaning up listeners from existing connection', { workspaceId });
            cleanupTerminalListeners(existingWs);
          }
        }
      }

      const cleanupMap = terminalListenerCleanup.get(ws);
      for (const terminal of existingTerminals) {
        const unsubscribers: (() => void)[] = [];
        if (cleanupMap) {
          cleanupMap.set(terminal.id, unsubscribers);
        }

        const unsubOutput = terminalService.onOutput(terminal.id, (output) => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'output', terminalId: terminal.id, data: output }));
          }
        });
        unsubscribers.push(unsubOutput);

        const unsubExit = terminalService.onExit(terminal.id, (exitCode) => {
          logger.info('Terminal process exited', { terminalId: terminal.id, exitCode });
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'exit', terminalId: terminal.id, exitCode }));
          }
          const exitCleanupMap = terminalListenerCleanup.get(ws);
          if (exitCleanupMap) {
            exitCleanupMap.delete(terminal.id);
          }
          terminalSessionAccessor.clearPid(terminal.id).catch((err) => {
            logger.warn('Failed to clear terminal PID', { terminalId: terminal.id, error: err });
          });
        });
        unsubscribers.push(unsubExit);
      }
    }

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: WebSocket handler needs to handle multiple message types
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        logger.debug('Received terminal message', {
          workspaceId,
          type: message.type,
          terminalId: message.terminalId,
        });

        switch (message.type) {
          case 'create': {
            logger.info('Creating terminal', {
              workspaceId,
              cols: message.cols,
              rows: message.rows,
            });
            const workspace = await workspaceAccessor.findById(workspaceId);
            if (!workspace?.worktreePath) {
              logger.warn('Workspace not found or has no worktree', { workspaceId });
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: 'Workspace not found or has no worktree',
                })
              );
              return;
            }

            logger.info('Creating terminal with worktree', {
              workspaceId,
              worktreePath: workspace.worktreePath,
            });
            const { terminalId, pid } = await terminalService.createTerminal({
              workspaceId,
              workingDir: workspace.worktreePath,
              cols: message.cols ?? 80,
              rows: message.rows ?? 24,
            });

            await terminalSessionAccessor.create({
              workspaceId,
              name: terminalId,
              pid,
            });

            const cleanupMap = terminalListenerCleanup.get(ws);
            const unsubscribers: (() => void)[] = [];
            if (cleanupMap) {
              cleanupMap.set(terminalId, unsubscribers);
            }

            logger.debug('Setting up output forwarding', { terminalId });
            const unsubOutput = terminalService.onOutput(terminalId, (output) => {
              if (ws.readyState === 1) {
                logger.debug('Forwarding output to client', {
                  terminalId,
                  outputLen: output.length,
                });
                ws.send(JSON.stringify({ type: 'output', terminalId, data: output }));
              } else {
                logger.warn('Cannot forward output - WebSocket not open', {
                  terminalId,
                  readyState: ws.readyState,
                });
              }
            });
            unsubscribers.push(unsubOutput);

            const unsubExit = terminalService.onExit(terminalId, (exitCode) => {
              logger.info('Terminal process exited', { terminalId, exitCode });
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'exit', terminalId, exitCode }));
              }
              const exitCleanupMap = terminalListenerCleanup.get(ws);
              if (exitCleanupMap) {
                exitCleanupMap.delete(terminalId);
              }
              terminalSessionAccessor.clearPid(terminalId).catch((err) => {
                logger.warn('Failed to clear terminal PID', { terminalId, error: err });
              });
            });
            unsubscribers.push(unsubExit);

            logger.info('Sending created message to client', { terminalId });
            ws.send(JSON.stringify({ type: 'created', terminalId }));
            break;
          }

          case 'input': {
            if (message.terminalId && message.data) {
              logger.debug('Writing input to terminal', {
                terminalId: message.terminalId,
                dataLen: message.data.length,
              });
              const success = terminalService.writeToTerminal(
                workspaceId,
                message.terminalId,
                message.data
              );
              if (!success) {
                logger.warn('Failed to write to terminal', {
                  workspaceId,
                  terminalId: message.terminalId,
                });
              }
            } else {
              logger.warn('Input message missing terminalId or data', { message });
            }
            break;
          }

          case 'resize': {
            if (message.terminalId && message.cols && message.rows) {
              logger.debug('Resizing terminal', {
                terminalId: message.terminalId,
                cols: message.cols,
                rows: message.rows,
              });
              terminalService.resizeTerminal(
                workspaceId,
                message.terminalId,
                message.cols,
                message.rows
              );
            } else {
              logger.warn('Resize message missing required fields', { message });
            }
            break;
          }

          case 'destroy': {
            if (message.terminalId) {
              logger.info('Destroying terminal', { terminalId: message.terminalId });
              const cleanupMap = terminalListenerCleanup.get(ws);
              const unsubs = cleanupMap?.get(message.terminalId);
              if (unsubs) {
                for (const unsub of unsubs) {
                  unsub();
                }
                cleanupMap?.delete(message.terminalId);
              }
              terminalService.destroyTerminal(workspaceId, message.terminalId);
            }
            break;
          }

          case 'set_active': {
            if (message.terminalId) {
              logger.debug('Setting active terminal', {
                workspaceId,
                terminalId: message.terminalId,
              });
              terminalService.setActiveTerminal(workspaceId, message.terminalId);
            }
            break;
          }

          default:
            logger.warn('Unknown message type', { type: message.type });
        }
      } catch (error) {
        const err = error as Error;
        const isParsError = err instanceof SyntaxError;
        const errorMessage = isParsError
          ? 'Invalid message format'
          : `Operation failed: ${err.message}`;

        logger.error('Error handling terminal message', err, {
          workspaceId,
          isParsError,
        });

        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'error', message: errorMessage }));
        }
      }
    });

    ws.on('close', () => {
      logger.info('Terminal WebSocket connection closed', { workspaceId });

      cleanupTerminalListeners(ws);

      const connections = terminalConnections.get(workspaceId);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) {
          terminalConnections.delete(workspaceId);
          logger.info('Starting terminal grace period', {
            workspaceId,
            gracePeriodMs: TERMINAL_GRACE_PERIOD_MS,
          });
          const gracePeriodTimeout = setTimeout(() => {
            if (!terminalConnections.has(workspaceId)) {
              logger.info('Grace period expired, destroying workspace terminals', {
                workspaceId,
              });
              terminalService.destroyWorkspaceTerminals(workspaceId);
            }
            terminalGracePeriods.delete(workspaceId);
          }, TERMINAL_GRACE_PERIOD_MS);
          terminalGracePeriods.set(workspaceId, gracePeriodTimeout);
        }
      }
    });

    ws.on('error', (error) => {
      logger.error('Terminal WebSocket error', error);
    });
  });
}
