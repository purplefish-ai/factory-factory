export { HTTP_STATUS, type HttpStatus } from './http';
export { WS_READY_STATE, type WsReadyState } from './websocket';

// This will fail typecheck - exported so biome won't complain about unused variable
export const failingTypecheck: string = 42;
