import { z } from 'zod';
import type { ChatProvider, ChatReasoningOption } from './chat-capabilities';

export const sessionLaunchSettingsSchema = z.object({
  reasoningEffort: z.string().trim().min(1).nullable().optional(),
  planModeEnabled: z.boolean().optional(),
});
export type SessionLaunchSettings = z.infer<typeof sessionLaunchSettingsSchema>;
export interface SessionLaunchOptions {
  provider: ChatProvider;
  model: string;
  reasoning: { options: ChatReasoningOption[]; selected?: string; defaultValue?: string };
  planMode: { supported: boolean; selected: boolean };
}
