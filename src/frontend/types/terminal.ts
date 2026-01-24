/**
 * Terminal WebSocket message types for frontend-backend communication
 */

// Connection status states
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

// Messages sent from client to server
export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

// Messages received from server
export type ServerMessage =
  | { type: 'output'; data: string }
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number };

// Terminal dimensions
export interface TerminalDimensions {
  cols: number;
  rows: number;
}
