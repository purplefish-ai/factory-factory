import { z } from 'zod';
import {
  isNativeModeConfigOption,
  isReasoningConfigOption,
} from '@/backend/services/session/service/acp/acp-config-option-identification';
import { sessionLaunchSettingsSchema, type SessionLaunchSettings } from '@/shared/session-launch';
const metadataSchema = z.record(z.string(), z.unknown());
const storedLaunchSchema = sessionLaunchSettingsSchema.extend({
  applied: z.boolean().default(false),
});
export function readSessionLaunchSettings(
  metadata: unknown
): z.infer<typeof storedLaunchSchema> | undefined {
  const record = metadataSchema.safeParse(metadata);
  if (!record.success || record.data.launchSettings === undefined) {
    return undefined;
  }
  const parsed = storedLaunchSchema.safeParse(record.data.launchSettings);
  if (!parsed.success) {
    throw new Error('Saved session launch settings are invalid');
  }
  return parsed.data;
}
export function createSessionLaunchMetadata(input: SessionLaunchSettings) {
  const settings = sessionLaunchSettingsSchema.parse(input);
  if (settings.reasoningEffort === undefined && settings.planModeEnabled === undefined) {
    return undefined;
  }
  return {
    launchSettings: {
      ...(settings.reasoningEffort !== undefined
        ? { reasoningEffort: settings.reasoningEffort }
        : {}),
      ...(settings.planModeEnabled !== undefined
        ? { planModeEnabled: settings.planModeEnabled }
        : {}),
      applied: false,
    },
  };
}
/** Only the startup owner's final confirmed snapshot may consume initial intent. */
export function markSessionLaunchSettingsApplied(metadata: unknown): unknown {
  const settings = readSessionLaunchSettings(metadata);
  if (!settings || settings.applied) {
    return metadata;
  }
  return { ...metadataSchema.parse(metadata), launchSettings: { ...settings, applied: true } };
}

/** Explicit stopped-session edits supersede only their corresponding unconsumed launch field. */
export function pendingSessionLaunchSettingsPatch(
  metadata: unknown,
  provider: string,
  option: { id: string; category?: string | null } | undefined,
  value: string
): SessionLaunchSettings | undefined {
  const launch = readSessionLaunchSettings(metadata);
  if (!launch || launch.applied || !option) {
    return undefined;
  }
  const reasoning = isReasoningConfigOption(option);
  const planning = isNativeModeConfigOption(
    option,
    provider === 'CLAUDE' ? 'mode' : 'collaboration_mode'
  );
  const edited = reasoning
    ? { reasoningEffort: value }
    : planning
      ? { planModeEnabled: value === 'plan' }
      : undefined;
  return edited;
}
