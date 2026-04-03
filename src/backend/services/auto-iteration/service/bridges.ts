/**
 * Bridge interfaces for auto-iteration cross-service dependencies.
 * Injected by the orchestration layer at startup.
 * The auto-iteration domain never imports from other domains directly.
 */

import type { AutoIterationStatus } from '@/shared/core';
import type {
  AgentLogbook,
  AgentLogbookEntry,
  AutoIterationConfig,
  AutoIterationProgress,
} from './auto-iteration.types';

/** Session capabilities needed by auto-iteration. */
export interface AutoIterationSessionBridge {
  startSession(
    workspaceId: string,
    opts: { initialPrompt?: string; startupModePreset?: 'non_interactive' }
  ): Promise<string>; // returns sessionId
  sendPrompt(sessionId: string, prompt: string, timeoutMs?: number): Promise<void>;
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

/** Logbook capabilities needed by auto-iteration. */
export interface AutoIterationLogbookBridge {
  initialize(
    worktreePath: string,
    workspaceId: string,
    config: AutoIterationConfig,
    baselineOutput: string,
    baselineMetricSummary: string
  ): Promise<void>;
  appendEntry(worktreePath: string, entry: AgentLogbookEntry): Promise<void>;
  read(worktreePath: string): Promise<AgentLogbook | null>;
  /** Read the user-editable strategy file. Returns null if absent. */
  readStrategyFile(worktreePath: string): Promise<string | null>;
  /** Seed the default strategy file template. No-op if the file already exists. */
  writeStrategyFile(worktreePath: string, content: string): Promise<void>;
}
