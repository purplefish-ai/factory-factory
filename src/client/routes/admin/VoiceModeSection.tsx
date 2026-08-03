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

  const validateApiKey = trpc.voice.validateApiKey.useMutation({
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

  const updateConfig = trpc.voice.updateConfig.useMutation({
    onSuccess: () => {
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
              onChange={(e) => {
                setApiKey(e.target.value);
                setValidatedKey(null);
              }}
              placeholder={hasStoredKey ? '••••••••••••••••••••' : 'Enter your Deepgram API key'}
              className="font-mono text-sm w-[280px]"
            />
          </div>
          <Button
            variant="outline"
            onClick={handleValidate}
            disabled={validateApiKey.isPending || !apiKey}
          >
            {validateApiKey.isPending ? 'Validating...' : 'Validate'}
          </Button>
          {validated && (
            <Button onClick={handleSaveKey} disabled={updateConfig.isPending}>
              {updateConfig.isPending ? 'Saving...' : 'Save'}
            </Button>
          )}
        </div>

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
        </div>
      </CardContent>
    </Card>
  );
}
