/**
 * Shared protocol and type definitions for chat/WebSocket communication.
 *
 * Compatibility barrel: public imports from `@/shared/claude/protocol` remain stable
 * while implementation details live under `./protocol/*`.
 */

export type { PendingInteractiveRequest } from '../pending-request-types';

export * from './protocol/index';
