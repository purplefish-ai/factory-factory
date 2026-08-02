import { MicrophoneIcon, MicrophoneSlashIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
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
  const { isCapturing, error, start, stop } = useMicCapture({
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
    } else {
      setVoiceModeOn(true);
      void start();
    }
  }, [isCapturing, start, stop]);

  if (!(config?.enabled && config.hasApiKey)) {
    return null;
  }

  return (
    <Button
      type="button"
      variant={isCapturing ? 'default' : 'outline'}
      size="sm"
      className="shrink-0"
      disabled={disabled || !sessionId}
      title={error ?? (isCapturing ? 'Exit voice mode' : 'Enter voice mode')}
      onClick={handleClick}
    >
      {isCapturing ? (
        <MicrophoneIcon className={isSpeaking ? 'h-4 w-4 animate-pulse' : 'h-4 w-4'} />
      ) : (
        <MicrophoneSlashIcon className="h-4 w-4" />
      )}
      {isCapturing ? 'Voice On' : 'Voice Off'}
    </Button>
  );
}
