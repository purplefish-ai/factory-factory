import { z } from 'zod';
import type { ChatProvider, ChatReasoningOption } from './chat-capabilities';
import type { SessionPermissionPreset } from './core';

export const sessionLaunchSettingsSchema = z.object({
  accessMode: z.string().trim().min(1).optional(),
  reasoningEffort: z.string().trim().min(1).nullable().optional(),
  planModeEnabled: z.boolean().optional(),
});
export type SessionLaunchSettings = z.infer<typeof sessionLaunchSettingsSchema>;
export interface SessionLaunchOptions {
  provider: ChatProvider;
  model: string;
  reasoning: { options: ChatReasoningOption[]; selected?: string; defaultValue?: string };
  planMode: { supported: boolean; selected: boolean };
  accessMode?: { options: ChatReasoningOption[]; selected?: string };
}

/** Saved permission presets map to provider-native access choices. */
export function resolveLaunchAccessMode(
  provider: string,
  preset: SessionPermissionPreset,
  values: readonly string[]
): string | undefined {
  const targets =
    provider === 'CODEX'
      ? { STRICT: 'workspace-write', RELAXED: 'agent', YOLO: 'agent-full-access' }
      : { STRICT: 'default', RELAXED: 'auto', YOLO: 'bypassPermissions' };
  const target = targets[preset];
  if (values.includes(target)) {
    return target;
  }
  return provider === 'CLAUDE' && target === 'auto' && values.includes('acceptEdits')
    ? 'acceptEdits'
    : undefined;
}
