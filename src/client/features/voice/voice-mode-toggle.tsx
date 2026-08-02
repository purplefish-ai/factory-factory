import { MicrophoneIcon, MicrophoneSlashIcon, SpinnerGapIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useMicCapture } from './use-mic-capture';
import { useVoicePlayback } from './use-voice-playback';

export interface VoiceModeToggleProps {
  sessionId: string | null;
  /** Called with the final transcript of each spoken utterance. */
  onFinalTranscript: (text: string) => void;
  /** Whether the agent turn is currently running — gates "please stop" detection. */
  running?: boolean;
  disabled?: boolean;
}

interface VoiceStatus {
  label: string;
  title: string;
}

function getVoiceStatus(
  isConnecting: boolean,
  isCapturing: boolean,
  error: string | null
): VoiceStatus {
  if (error) {
    const label = isCapturing ? 'Voice On' : 'Voice Off';
    return { label, title: error };
  }
  if (isConnecting) {
    return { label: 'Connecting…', title: 'Connecting to Deepgram — speech is not captured yet' };
  }
  if (isCapturing) {
    return { label: 'Voice On', title: 'Exit voice mode' };
  }
  return { label: 'Voice Off', title: 'Enter voice mode' };
}

/** Small dot + text next to the button clarifying whether speech is actually being captured yet. */
function VoiceStatusBadge({
  isConnecting,
  isCapturing,
  isSpeaking,
}: {
  isConnecting: boolean;
  isCapturing: boolean;
  isSpeaking: boolean;
}) {
  if (!(isConnecting || isCapturing)) {
    return null;
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          isConnecting && 'animate-pulse bg-amber-500',
          isCapturing && isSpeaking && 'animate-pulse bg-blue-500',
          isCapturing && !isSpeaking && 'bg-green-500'
        )}
      />
      {isConnecting ? 'Connecting' : isSpeaking ? 'Speaking' : 'Listening'}
    </span>
  );
}

/**
 * Voice mode control: toggling it on starts mic capture (STT, direct to
 * Deepgram) and connects the /voice WebSocket for TTS playback of the
 * agent's replies. Renders nothing unless an admin has enabled voice mode
 * and configured a Deepgram API key (src/backend/trpc/voice.trpc.ts).
 *
 * Also wires the two Phase 4 behaviors: a spoken "please stop" cancels the
 * in-flight turn via soft_stop, and the user starting to talk immediately
 * pauses any in-progress TTS playback (barge-in).
 */
export function VoiceModeToggle({
  sessionId,
  onFinalTranscript,
  running,
  disabled,
}: VoiceModeToggleProps) {
  const { data: config } = trpc.voice.getConfig.useQuery();
  // Drives useVoicePlayback directly (rather than useMicCapture's isCapturing)
  // to avoid a circular dependency: useMicCapture needs useVoicePlayback's
  // sendSoftStop/stopPlayback, so useVoicePlayback must be constructed first.
  const [voiceModeOn, setVoiceModeOn] = useState(false);
  const { isSpeaking, sendSoftStop, stopPlayback } = useVoicePlayback({
    sessionId,
    enabled: voiceModeOn,
  });
  const { isCapturing, isConnecting, error, start, stop } = useMicCapture({
    onFinalTranscript,
    running,
    onSoftStop: sendSoftStop,
    onSpeechDetected: stopPlayback,
  });

  useEffect(() => {
    return () => stop();
  }, [stop]);

  useEffect(() => {
    if (error) {
      toast.error(error);
      // start() failed after we optimistically flipped this on — make sure
      // playback doesn't stay "enabled" for a capture session that never started.
      setVoiceModeOn(false);
    }
  }, [error]);

  const handleClick = useCallback(() => {
    if (isCapturing) {
      stop();
      setVoiceModeOn(false);
    } else if (!isConnecting) {
      setVoiceModeOn(true);
      void start();
    }
  }, [isCapturing, isConnecting, start, stop]);

  if (!(config?.enabled && config.hasApiKey)) {
    return null;
  }

  const status = getVoiceStatus(isConnecting, isCapturing, error);

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Button
        type="button"
        variant={isCapturing ? 'default' : 'outline'}
        size="sm"
        className="shrink-0"
        disabled={disabled || !sessionId || isConnecting}
        title={status.title}
        onClick={handleClick}
      >
        {isConnecting ? (
          <SpinnerGapIcon className="h-4 w-4 animate-spin" />
        ) : isCapturing ? (
          <MicrophoneIcon className={isSpeaking ? 'h-4 w-4 animate-pulse' : 'h-4 w-4'} />
        ) : (
          <MicrophoneSlashIcon className="h-4 w-4" />
        )}
        {status.label}
      </Button>
      <VoiceStatusBadge
        isConnecting={isConnecting}
        isCapturing={isCapturing}
        isSpeaking={isSpeaking}
      />
    </div>
  );
}
