/**
 * WebSocket Handlers
 *
 * Exports WebSocket upgrade handlers for chat and terminal connections.
 */

export {
  chatConnections,
  clientEventSetup,
  handleChatUpgrade,
  pendingMessages,
} from './chat.handler';

export {
  handleTerminalUpgrade,
  TERMINAL_GRACE_PERIOD_MS,
  terminalConnections,
  terminalGracePeriods,
} from './terminal.handler';
