import { CheckCircleIcon, MicrophoneIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

export function VoiceModeSection() {
  const { data: config, isLoading } = trpc.voice.getConfig.useQuery();
  const utils = trpc.useUtils();
  const [apiKey, setApiKey] = useState('');
  const [validated, setValidated] = useState(false);

  const validateApiKey = trpc.voice.validateApiKey.useMutation({
    onSuccess: (result) => {
      setValidated(result.valid);
      if (result.valid) {
        toast.success('Deepgram API key is valid');
      } else {
        toast.error(`Validation failed: ${result.error ?? 'Unknown error'}`);
      }
    },
    onError: (error) => toast.error(`Validation failed: ${error.message}`),
  });

  const updateConfig = trpc.voice.updateConfig.useMutation({
    onSuccess: () => {
      toast.success('Voice mode settings saved');
      utils.voice.getConfig.invalidate();
      setApiKey('');
      setValidated(false);
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

  const handleValidate = () => {
    if (apiKey) {
      validateApiKey.mutate({ apiKey });
    }
  };

  const handleSaveKey = () => {
    if (apiKey && validated) {
      updateConfig.mutate({ enabled, apiKey });
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
                setValidated(false);
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
      </CardContent>
    </Card>
  );
}
