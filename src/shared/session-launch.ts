import { z } from 'zod';
import type { ChatProvider, ChatReasoningOption } from './chat-capabilities';
import type { SessionPermissionPreset } from './core';

export const CLAUDE_AUTO_FALLBACK = 'acceptEdits';

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

/** Canonical access intent, frozen before provider capabilities are available. */
export function resolvePermissionPresetAccessMode(
  provider: string,
  preset: SessionPermissionPreset
): string {
  const targets =
    provider === 'CODEX'
      ? { STRICT: 'workspace-write', RELAXED: 'agent', YOLO: 'agent-full-access' }
      : { STRICT: 'default', RELAXED: 'auto', YOLO: 'bypassPermissions' };
  return targets[preset];
}

/** Saved permission presets map to supported provider-native access choices. */
export function resolveLaunchAccessMode(
  provider: string,
  preset: SessionPermissionPreset,
  values: readonly string[]
): string | undefined {
  const target = resolvePermissionPresetAccessMode(provider, preset);
  if (values.includes(target)) {
    return target;
  }
  return provider === 'CLAUDE' && target === 'auto' && values.includes(CLAUDE_AUTO_FALLBACK)
    ? CLAUDE_AUTO_FALLBACK
    : undefined;
}
