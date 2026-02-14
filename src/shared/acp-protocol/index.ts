/**
 * Shared UI/backend protocol for ACP-driven agent sessions.
 *
 * This is the canonical contract surface for WebSocket/session events and
 * transcript data rendered by the frontend.
 */
export * from '@/shared/session-runtime';
export * from './protocol/index';

// Optional aliases for clearer ACP-oriented call sites.
export type { ChatMessage as AgentChatMessage } from './protocol/messages';
export type { SessionDeltaEvent as AgentSessionDeltaEvent } from './protocol/websocket';
