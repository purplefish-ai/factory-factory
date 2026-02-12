import {
  type ClaudeRuntimeCreatedCallback,
  type ClaudeRuntimeEventHandlers,
  ClaudeRuntimeManager,
  claudeRuntimeManager,
} from '@/backend/domains/session/runtime';

export type ClientCreatedCallback = ClaudeRuntimeCreatedCallback;
export type ClientEventHandlers = ClaudeRuntimeEventHandlers;

// Compatibility aliases retained during runtime-manager migration.
export class SessionProcessManager extends ClaudeRuntimeManager {}

export const sessionProcessManager = claudeRuntimeManager;
