import type { EventInitialPermit } from '@/backend/services/session/service/event-agent/event-session-authority';
export type SessionStartupModePreset = 'non_interactive' | 'plan';

export type GetOrCreateSessionClientOptions = {
  eventInitial?: EventInitialPermit;
  assertCurrent?: () => Promise<void>;
  assertCurrentSync?: () => void;
  resumePolicy?: 'allow_fallback' | 'require_existing';
  thinkingEnabled?: boolean;
  model?: string;
  reasoningEffort?: string | null;
  planModeEnabled?: boolean;
  startupModePreset?: SessionStartupModePreset;
};

export type StartSessionOptions = {
  assertCurrent?: () => Promise<void>;
  assertCurrentSync?: () => void;
  initialPrompt?: string;
  initialPromptIsDefault?: boolean;
  startupModePreset?: SessionStartupModePreset;
};
