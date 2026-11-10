import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { MicrophoneIcon } from '@phosphor-icons/react/dist/csr/Microphone';
import { getMutationKey } from '@trpc/react-query';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { useState } from 'react';
import { toast } from 'sonner';
import { runInBackground } from '@/client/lib/background-task';
import {
  createPatchRollback,
  pendingPatches,
  useSavingFields,
} from '@/client/lib/optimistic-patch';
import { type AppRouter, trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  DEEPGRAM_FLUX_ENGLISH_VOICES,
  DEEPGRAM_TTS_SPEED_MAX,
  DEEPGRAM_TTS_SPEED_MIN,
  DEEPGRAM_TTS_SPEED_STEP,
} from '@/shared/deepgram-voices';
import {
  deriveAggressivenessLabel,
  VOICE_BARGE_IN_SUSTAINED_MS_MAX,
  VOICE_BARGE_IN_SUSTAINED_MS_MIN,
  VOICE_BARGE_IN_SUSTAINED_MS_STEP,
  VOICE_UTTERANCE_END_MS_MAX,
  VOICE_UTTERANCE_END_MS_MIN,
  VOICE_UTTERANCE_END_MS_STEP,
} from '@/shared/voice-vad';
import {
  SETTING_FIELD_WIDTH,
  SettingField,
  SettingRow,
  SettingSelect,
  SettingsSection,
  useSliderDraft,
} from './settings-section';

type VoiceConfigPatch = inferRouterInputs<AppRouter>['voice']['updateConfig'];
type VoiceConfig = inferRouterOutputs<AppRouter>['voice']['getConfig'];

const voiceRollback = createPatchRollback<VoiceConfig>();

const VOICE_OPTIONS = DEEPGRAM_FLUX_ENGLISH_VOICES.map((voice) => ({
  value: voice.model,
  label: voice.description ? `${voice.name} — ${voice.description}` : voice.name,
}));

interface VoiceSliderProps {
  id: string;
  label: string;
  helpText?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  formatValue: (value: number) => string;
  disabled: boolean;
  saving: boolean;
  onCommit: (value: number) => void;
}

/** A saved slider: shows its value while dragging and saves on release. */
function VoiceSlider({
  id,
  label,
  helpText,
  value,
  min,
  max,
  step,
  formatValue,
  disabled,
  saving,
  onCommit,
}: VoiceSliderProps) {
  const { shown, onValueChange, onValueCommit } = useSliderDraft(value, onCommit);
  return (
    <SettingField
      label={label}
      htmlFor={id}
      saving={saving}
      labelAccessory={
        <span className="text-xs text-muted-foreground font-mono">{formatValue(shown)}</span>
      }
      description={helpText}
    >
      <Slider
        id={id}
        className={SETTING_FIELD_WIDTH}
        value={[shown]}
        onValueChange={onValueChange}
        onValueCommit={onValueCommit}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
      />
    </SettingField>
  );
}

/** Split out of VoiceModeSection so its nested success/error branching doesn't count against that component's own complexity budget. */
function useValidateApiKeyMutation(apiKey: string, setValidatedKey: (key: string | null) => void) {
  return trpc.voice.validateApiKey.useMutation({
    onSuccess: (result, variables) => {
      if (result.valid) {
        setValidatedKey(variables.apiKey);
        toast.success('Deepgram API key is valid');
      } else {
        // A validation call for a key the user has since edited away from
        // must not clear the valid state of whatever they're validating
        // now — only clobber if this failure is actually for the key still
        // in the field.
        if (variables.apiKey === apiKey) {
          setValidatedKey(null);
        }
        toast.error(`Couldn't validate the Deepgram API key. ${result.error ?? 'Unknown error'}`);
      }
    },
    onError: (error, variables) => {
      if (variables.apiKey === apiKey) {
        setValidatedKey(null);
      }
      toast.error(`Couldn't validate the Deepgram API key. ${error.message}`);
    },
  });
}

/** Saves voice settings one at a time, showing each change before the server confirms it. */
function useUpdateVoiceConfig() {
  const utils = trpc.useUtils();
  const mutationKey = getMutationKey(trpc.voice.updateConfig);
  const mutation = trpc.voice.updateConfig.useMutation({
    scope: { id: 'voice-config' },
    onMutate: async (patch) => {
      await utils.voice.getConfig.cancel();
      const previous = utils.voice.getConfig.getData();
      if (previous) {
        voiceRollback.remember(patch, previous);
      }
      const { apiKey: _apiKey, ...visible } = patch;
      utils.voice.getConfig.setData(undefined, (current) =>
        current ? { ...current, ...visible } : current
      );
    },
    onError: (error, patch, _context, { client }) => {
      utils.voice.getConfig.setData(undefined, (current) =>
        current
          ? voiceRollback.restore(current, patch, pendingPatches(client, mutationKey))
          : current
      );
      toast.error("Couldn't save voice settings.", { description: error.message });
    },
    onSettled: (config, _error, _patch, _context, { client }) => {
      // Earlier results would hide newer optimistic values.
      if (client.isMutating({ mutationKey }) > 1) {
        return;
      }
      if (config) {
        utils.voice.getConfig.setData(undefined, config);
      }
      runInBackground(utils.voice.getConfig.invalidate(), "Couldn't refresh voice settings.");
    },
  });
  const isSaving: (field: keyof VoiceConfigPatch) => boolean = useSavingFields(mutationKey);
  return { ...mutation, isSaving };
}

interface DeepgramApiKeyFieldProps {
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  validated: boolean;
  hasStoredKey: boolean;
  validating: boolean;
  saving: boolean;
  onValidate: () => void;
  onSave: () => void;
}

/** Split out of VoiceModeSection so its validity-badge/button-label branching doesn't count against that component's own complexity budget. */
function DeepgramApiKeyField({
  apiKey,
  onApiKeyChange,
  validated,
  hasStoredKey,
  validating,
  saving,
  onValidate,
  onSave,
}: DeepgramApiKeyFieldProps) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="w-full min-w-0 space-y-1.5 sm:w-auto">
        <div className="flex items-center gap-2">
          <Label htmlFor="deepgram-api-key">Deepgram API Key</Label>
          {validated && (
            <span className="flex items-center gap-1 text-xs text-success">
              <CheckCircleIcon className="w-3 h-3" />
              Valid
            </span>
          )}
        </div>
        <Input
          id="deepgram-api-key"
          type="password"
          value={apiKey}
          onChange={(e) => onApiKeyChange(e.target.value)}
          placeholder={hasStoredKey ? '••••••••••••••••••••' : 'Enter your Deepgram API key'}
          className={`font-mono text-sm ${SETTING_FIELD_WIDTH}`}
        />
      </div>
      <Button
        variant="outline"
        onClick={onValidate}
        pending={validating}
        pendingLabel="Validating…"
        disabled={!apiKey}
      >
        Validate
      </Button>
      {validated && (
        <Button onClick={onSave} pending={saving} pendingLabel="Saving…">
          Save
        </Button>
      )}
    </div>
  );
}

export function VoiceModeSection() {
  const configQuery = trpc.voice.getConfig.useQuery();
  const [apiKey, setApiKey] = useState('');
  // Tied to the exact key text that was validated, rather than a bare
  // boolean, so a validation response that resolves after the user has
  // already edited the field can't mark the new, unvalidated text as valid.
  const [validatedKey, setValidatedKey] = useState<string | null>(null);
  const validated = validatedKey !== null && validatedKey === apiKey;
  const validateApiKey = useValidateApiKeyMutation(apiKey, setValidatedKey);
  const updateConfig = useUpdateVoiceConfig();

  const handleValidate = () => {
    if (apiKey) {
      validateApiKey.mutate({ apiKey });
    }
  };

  const handleSaveKey = () => {
    if (apiKey && validated) {
      // Cleared only on success — clearing eagerly would force re-entering
      // and re-validating the key after a failed save, even though the
      // validated text the user already typed is still sitting right there.
      updateConfig.mutate(
        { apiKey },
        {
          onSuccess: () => {
            setApiKey('');
            setValidatedKey(null);
          },
        }
      );
    }
  };

  return (
    <SettingsSection
      title="Voice mode"
      icon={<MicrophoneIcon className="w-5 h-5" />}
      description="Talk to Claude/Codex sessions by voice using your own Deepgram API key for speech-to-text and text-to-speech."
      query={configQuery}
      errorTitle="Couldn't load voice settings"
    >
      {(config) => (
        <>
          <SettingRow
            label="Enable voice mode"
            htmlFor="voice-mode-enabled"
            description={
              config.hasApiKey ? 'Available in workspace chat' : 'Requires a Deepgram API key below'
            }
            saving={updateConfig.isSaving('enabled')}
          >
            <Switch
              id="voice-mode-enabled"
              checked={config.enabled}
              onCheckedChange={(checked) => updateConfig.mutate({ enabled: checked })}
              disabled={!config.hasApiKey}
            />
          </SettingRow>

          <DeepgramApiKeyField
            apiKey={apiKey}
            onApiKeyChange={(value) => {
              setApiKey(value);
              setValidatedKey(null);
            }}
            validated={validated}
            hasStoredKey={config.hasApiKey}
            validating={validateApiKey.isPending}
            saving={updateConfig.isSaving('apiKey')}
            onValidate={handleValidate}
            onSave={handleSaveKey}
          />

          <p className="text-xs text-muted-foreground">
            Create an API key at{' '}
            <a
              href="https://console.deepgram.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              console.deepgram.com
            </a>
          </p>

          <div className="border-t pt-4 space-y-4">
            <SettingSelect
              id="voice-model"
              label="Voice"
              description="Deepgram Flux TTS English voices"
              saving={updateConfig.isSaving('ttsModel')}
              value={config.ttsModel}
              options={VOICE_OPTIONS}
              onValueChange={(ttsModel) => updateConfig.mutate({ ttsModel })}
              disabled={!config.hasApiKey}
              triggerClassName={SETTING_FIELD_WIDTH}
            />

            <VoiceSlider
              id="voice-speed"
              label="Speed"
              value={config.ttsSpeed}
              min={DEEPGRAM_TTS_SPEED_MIN}
              max={DEEPGRAM_TTS_SPEED_MAX}
              step={DEEPGRAM_TTS_SPEED_STEP}
              formatValue={(value) => `${value.toFixed(2)}x`}
              disabled={!config.hasApiKey}
              saving={updateConfig.isSaving('ttsSpeed')}
              onCommit={(ttsSpeed) => updateConfig.mutate({ ttsSpeed })}
            />

            <VoiceSlider
              id="voice-utterance-end"
              label="Stop-speaking sensitivity"
              helpText="How long a pause before voice mode decides you've finished talking."
              value={config.utteranceEndMs}
              min={VOICE_UTTERANCE_END_MS_MIN}
              max={VOICE_UTTERANCE_END_MS_MAX}
              step={VOICE_UTTERANCE_END_MS_STEP}
              formatValue={(value) =>
                `${(value / 1000).toFixed(2)}s · ${deriveAggressivenessLabel(value, VOICE_UTTERANCE_END_MS_MIN, VOICE_UTTERANCE_END_MS_MAX)}`
              }
              disabled={!config.hasApiKey}
              saving={updateConfig.isSaving('utteranceEndMs')}
              onCommit={(utteranceEndMs) => updateConfig.mutate({ utteranceEndMs })}
            />

            <VoiceSlider
              id="voice-barge-in"
              label="Barge-in sensitivity"
              helpText="How quickly voice mode notices you've started talking over its spoken reply and stops to listen."
              value={config.bargeInSustainedMs}
              min={VOICE_BARGE_IN_SUSTAINED_MS_MIN}
              max={VOICE_BARGE_IN_SUSTAINED_MS_MAX}
              step={VOICE_BARGE_IN_SUSTAINED_MS_STEP}
              formatValue={(value) =>
                `${value}ms · ${deriveAggressivenessLabel(value, VOICE_BARGE_IN_SUSTAINED_MS_MIN, VOICE_BARGE_IN_SUSTAINED_MS_MAX)}`
              }
              disabled={!config.hasApiKey}
              saving={updateConfig.isSaving('bargeInSustainedMs')}
              onCommit={(bargeInSustainedMs) => updateConfig.mutate({ bargeInSustainedMs })}
            />
          </div>
        </>
      )}
    </SettingsSection>
  );
}
