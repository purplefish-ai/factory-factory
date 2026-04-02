/**
 * Bridge interfaces for auto-iteration cross-service dependencies.
 * Injected by the orchestration layer at startup.
 * The auto-iteration domain never imports from other domains directly.
 */

import type { AutoIterationStatus } from '@/shared/core';
import type { AutoIterationProgress } from './auto-iteration.types';

/** Session capabilities needed by auto-iteration. */
export interface AutoIterationSessionBridge {
  startSession(
    workspaceId: string,
    opts: { initialPrompt?: string; startupModePreset?: 'non_interactive' }
  ): Promise<string>; // returns sessionId
  sendPrompt(sessionId: string, prompt: string): Promise<void>;
  waitForIdle(sessionId: string): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  getLastAssistantMessage(sessionId: string): Promise<string>;
  recycleSession(workspaceId: string, handoffPrompt: string): Promise<string>; // stop old, start new, returns new sessionId
}

/** Workspace capabilities needed by auto-iteration. */
export interface AutoIterationWorkspaceBridge {
  getWorktreePath(workspaceId: string): Promise<string>;
  updateAutoIterationStatus(workspaceId: string, status: AutoIterationStatus): Promise<void>;
  updateAutoIterationProgress(workspaceId: string, progress: AutoIterationProgress): Promise<void>;
  updateAutoIterationSessionId(workspaceId: string, sessionId: string | null): Promise<void>;
}
