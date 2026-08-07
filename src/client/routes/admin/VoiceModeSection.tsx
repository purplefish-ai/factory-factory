import { CheckCircleIcon, MicrophoneIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  DEEPGRAM_AURA2_ENGLISH_VOICES,
  DEEPGRAM_TTS_SPEED_MAX,
  DEEPGRAM_TTS_SPEED_MIN,
  DEFAULT_DEEPGRAM_TTS_MODEL,
  DEFAULT_DEEPGRAM_TTS_SPEED,
} from '@/shared/deepgram-voices';
import {
  DEFAULT_VOICE_BARGE_IN_SUSTAINED_MS,
  DEFAULT_VOICE_UTTERANCE_END_MS,
  deriveAggressivenessLabel,
  VOICE_BARGE_IN_SUSTAINED_MS_MAX,
  VOICE_BARGE_IN_SUSTAINED_MS_MIN,
  VOICE_BARGE_IN_SUSTAINED_MS_STEP,
  VOICE_UTTERANCE_END_MS_MAX,
  VOICE_UTTERANCE_END_MS_MIN,
  VOICE_UTTERANCE_END_MS_STEP,
} from '@/shared/voice-vad';

type VoiceUpdateConfigMutation = ReturnType<typeof trpc.voice.updateConfig.useMutation>;

interface AggressivenessSliderProps {
  id: string;
  label: string;
  helpText: string;
  value: number;
  min: number;
  max: number;
  step: number;
  formatValue: (value: number) => string;
  disabled: boolean;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}

/** Shared shape for the "stop-speaking" and "barge-in" sensitivity sliders — each shows a raw value plus a derived Aggressive/Balanced/Patient label. */
function AggressivenessSlider({
  id,
  label,
  helpText,
  value,
  min,
  max,
  step,
  formatValue,
  disabled,
  onChange,
  onCommit,
}: AggressivenessSliderProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between w-[280px]">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-xs text-muted-foreground font-mono">
          {formatValue(value)} · {deriveAggressivenessLabel(value, min, max)}
        </span>
      </div>
      <Slider
        id={id}
        className="w-[280px]"
        value={[value]}
        onValueChange={([v]) => onChange(v ?? value)}
        onValueCommit={([v]) => onCommit(v ?? value)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
      />
      <p className="text-xs text-muted-foreground">{helpText}</p>
    </div>
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
        toast.error(`Validation failed: ${result.error ?? 'Unknown error'}`);
      }
    },
    onError: (error, variables) => {
      if (variables.apiKey === apiKey) {
        setValidatedKey(null);
      }
      toast.error(`Validation failed: ${error.message}`);
    },
  });
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
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Label htmlFor="deepgram-api-key">Deepgram API Key</Label>
          {validated && (
            <span className="flex items-center gap-1 text-xs text-green-600">
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
          className="font-mono text-sm w-[280px]"
        />
      </div>
      <Button variant="outline" onClick={onValidate} disabled={validating || !apiKey}>
        {validating ? 'Validating...' : 'Validate'}
      </Button>
      {validated && (
        <Button onClick={onSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      )}
    </div>
  );
}

interface VoiceSensitivitySlidersProps {
  utteranceEndMs: number | undefined;
  bargeInSustainedMs: number | undefined;
  enabled: boolean;
  disabled: boolean;
  updateConfig: VoiceUpdateConfigMutation;
}

/**
 * Owns local state and commit/revert handling for both aggressiveness
 * sliders — split out from VoiceModeSection so this pair of settings has its
 * own complexity budget rather than growing that component's.
 */
function VoiceSensitivitySliders({
  utteranceEndMs: configUtteranceEndMs,
  bargeInSustainedMs: configBargeInSustainedMs,
  enabled,
  disabled,
  updateConfig,
}: VoiceSensitivitySlidersProps) {
  const [utteranceEndMs, setUtteranceEndMs] = useState(DEFAULT_VOICE_UTTERANCE_END_MS);
  const [bargeInSustainedMs, setBargeInSustainedMs] = useState(DEFAULT_VOICE_BARGE_IN_SUSTAINED_MS);

  useEffect(() => {
    if (configUtteranceEndMs !== undefined) {
      setUtteranceEndMs(configUtteranceEndMs);
    }
  }, [configUtteranceEndMs]);

  useEffect(() => {
    if (configBargeInSustainedMs !== undefined) {
      setBargeInSustainedMs(configBargeInSustainedMs);
    }
  }, [configBargeInSustainedMs]);

  return (
    <>
      <AggressivenessSlider
        id="voice-utterance-end"
        label="Stop-speaking sensitivity"
        helpText="How long a pause before voice mode decides you've finished talking."
        value={utteranceEndMs}
        min={VOICE_UTTERANCE_END_MS_MIN}
        max={VOICE_UTTERANCE_END_MS_MAX}
        step={VOICE_UTTERANCE_END_MS_STEP}
        formatValue={(value) => `${(value / 1000).toFixed(2)}s`}
        disabled={disabled}
        onChange={setUtteranceEndMs}
        onCommit={(value) =>
          updateConfig.mutate(
            { enabled, utteranceEndMs: value },
            {
              onError: () =>
                setUtteranceEndMs(configUtteranceEndMs ?? DEFAULT_VOICE_UTTERANCE_END_MS),
            }
          )
        }
      />

      <AggressivenessSlider
        id="voice-barge-in"
        label="Barge-in sensitivity"
        helpText="How quickly voice mode notices you've started talking over its spoken reply and stops to listen."
        value={bargeInSustainedMs}
        min={VOICE_BARGE_IN_SUSTAINED_MS_MIN}
        max={VOICE_BARGE_IN_SUSTAINED_MS_MAX}
        step={VOICE_BARGE_IN_SUSTAINED_MS_STEP}
        formatValue={(value) => `${value}ms`}
        disabled={disabled}
        onChange={setBargeInSustainedMs}
        onCommit={(value) =>
          updateConfig.mutate(
            { enabled, bargeInSustainedMs: value },
            {
              onError: () =>
                setBargeInSustainedMs(
                  configBargeInSustainedMs ?? DEFAULT_VOICE_BARGE_IN_SUSTAINED_MS
                ),
            }
          )
        }
      />
    </>
  );
}

export function VoiceModeSection() {
  const { data: config, isLoading } = trpc.voice.getConfig.useQuery();
  const utils = trpc.useUtils();
  const [apiKey, setApiKey] = useState('');
  // Tied to the exact key text that was validated, rather than a bare
  // boolean, so a validation response that resolves after the user has
  // already edited the field can't mark the new, unvalidated text as valid.
  const [validatedKey, setValidatedKey] = useState<string | null>(null);
  const validated = validatedKey !== null && validatedKey === apiKey;
  const [speed, setSpeed] = useState(DEFAULT_DEEPGRAM_TTS_SPEED);

  useEffect(() => {
    if (config?.ttsSpeed !== undefined) {
      setSpeed(config.ttsSpeed);
    }
  }, [config?.ttsSpeed]);

  const validateApiKey = useValidateApiKeyMutation(apiKey, setValidatedKey);

  const updateConfig = trpc.voice.updateConfig.useMutation({
    onSuccess: (result) => {
      // Seed the cache with this mutation's own result before invalidating —
      // otherwise a second mutation (e.g. changing Speed right after
      // toggling Enable) fires while the invalidated query is still
      // refetching, reads the stale `config.enabled` closure below, and
      // resends it, silently reverting the toggle.
      utils.voice.getConfig.setData(undefined, result);
      utils.voice.getConfig.invalidate();
    },
    onError: (error) => toast.error(`Failed to save: ${error.message}`),
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MicrophoneIcon className="w-5 h-5" />
            Voice Mode
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  const hasStoredKey = config?.hasApiKey ?? false;
  const enabled = config?.enabled ?? false;
  const ttsModel = config?.ttsModel ?? DEFAULT_DEEPGRAM_TTS_MODEL;

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
        { enabled, apiKey },
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MicrophoneIcon className="w-5 h-5" />
          Voice Mode
        </CardTitle>
        <CardDescription>
          Talk to Claude/Codex sessions by voice using your own Deepgram API key for speech-to-text
          and text-to-speech.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="voice-mode-enabled">Enable voice mode</Label>
            <p className="text-sm text-muted-foreground">
              {hasStoredKey ? 'Available in workspace chat' : 'Requires a Deepgram API key below'}
            </p>
          </div>
          <Switch
            id="voice-mode-enabled"
            checked={enabled}
            onCheckedChange={(checked) => updateConfig.mutate({ enabled: checked })}
            disabled={updateConfig.isPending || !hasStoredKey}
          />
        </div>

        <DeepgramApiKeyField
          apiKey={apiKey}
          onApiKeyChange={(value) => {
            setApiKey(value);
            setValidatedKey(null);
          }}
          validated={validated}
          hasStoredKey={hasStoredKey}
          validating={validateApiKey.isPending}
          saving={updateConfig.isPending}
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
          <div className="space-y-1.5">
            <Label htmlFor="voice-model">Voice</Label>
            <Select
              value={ttsModel}
              onValueChange={(value) => updateConfig.mutate({ enabled, ttsModel: value })}
              disabled={updateConfig.isPending || !hasStoredKey}
            >
              <SelectTrigger id="voice-model" className="w-[280px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEEPGRAM_AURA2_ENGLISH_VOICES.map((voice) => (
                  <SelectItem key={voice.model} value={voice.model}>
                    {voice.name}
                    {voice.description ? ` — ${voice.description}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Deepgram Aura-2 English voices</p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between w-[280px]">
              <Label htmlFor="voice-speed">Speed</Label>
              <span className="text-xs text-muted-foreground font-mono">{speed.toFixed(1)}x</span>
            </div>
            <Slider
              id="voice-speed"
              className="w-[280px]"
              value={[speed]}
              onValueChange={([value]) => setSpeed(value ?? DEFAULT_DEEPGRAM_TTS_SPEED)}
              onValueCommit={([value]) =>
                updateConfig.mutate(
                  { enabled, ttsSpeed: value ?? DEFAULT_DEEPGRAM_TTS_SPEED },
                  {
                    // A failed save must not leave the slider showing a
                    // value voice playback isn't actually using — revert to
                    // whatever's still persisted.
                    onError: () => setSpeed(config?.ttsSpeed ?? DEFAULT_DEEPGRAM_TTS_SPEED),
                  }
                )
              }
              min={DEEPGRAM_TTS_SPEED_MIN}
              max={DEEPGRAM_TTS_SPEED_MAX}
              step={0.1}
              disabled={updateConfig.isPending || !hasStoredKey}
            />
          </div>

          <VoiceSensitivitySliders
            utteranceEndMs={config?.utteranceEndMs}
            bargeInSustainedMs={config?.bargeInSustainedMs}
            enabled={enabled}
            disabled={updateConfig.isPending || !hasStoredKey}
            updateConfig={updateConfig}
          />
        </div>
      </CardContent>
    </Card>
  );
}
