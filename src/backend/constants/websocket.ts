/**
 * WebSocket ready state constants.
 * @see https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/readyState
 */
export const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export type WsReadyState = (typeof WS_READY_STATE)[keyof typeof WS_READY_STATE];
