import { MicrophoneIcon, MicrophoneSlashIcon, SpinnerGapIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { playSound } from '@/client/lib/sound';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useMicCapture } from './use-mic-capture';
import { useVoicePlayback } from './use-voice-playback';

/**
 * Single source of truth for what voice mode is currently doing — both the
 * status badge label/dot and the Listening→Thinking transition sound are
 * derived from this, so they can never disagree about the current phase.
 */
type VoiceBadgePhase = 'off' | 'connecting' | 'speaking' | 'thinking' | 'listening';

function derivePhase(
  isConnecting: boolean,
  isCapturing: boolean,
  isSpeaking: boolean,
  isThinking: boolean
): VoiceBadgePhase {
  if (!(isConnecting || isCapturing)) {
    return 'off';
  }
  if (isConnecting) {
    return 'connecting';
  }
  if (isSpeaking) {
    return 'speaking';
  }
  if (isThinking) {
    return 'thinking';
  }
  return 'listening';
}

export interface VoiceModeToggleProps {
  sessionId: string | null;
  /** Called with the final transcript of each spoken utterance. */
  onFinalTranscript: (text: string, options?: { voiceMode?: boolean }) => void;
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
    return {
      label: 'Connecting…',
      title: 'Connecting to Deepgram — speech is not captured yet. Click to cancel.',
    };
  }
  if (isCapturing) {
    return { label: 'Voice On', title: 'Exit voice mode' };
  }
  return { label: 'Voice Off', title: 'Enter voice mode' };
}

/**
 * Small dot + text next to the button clarifying what voice mode is
 * currently doing. The mic keeps capturing continuously the whole time
 * voice mode is on (to catch a stop-phrase mid-turn and to detect barge-in),
 * so "Listening" alone can't distinguish "still waiting for you to finish
 * talking — nothing sent yet" from "your turn was sent, the agent is now
 * working on it." `running` (the agent turn's actual status) is what draws
 * that line: once it flips true, the badge switches to "Thinking" even
 * though capture never stopped.
 */
const VOICE_PHASE_LABELS: Record<VoiceBadgePhase, string> = {
  off: '',
  connecting: 'Connecting',
  speaking: 'Speaking',
  thinking: 'Thinking',
  listening: 'Listening',
};

function VoiceStatusBadge({ phase }: { phase: VoiceBadgePhase }) {
  if (phase === 'off') {
    return null;
  }
  return (
    <output className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          phase === 'connecting' && 'animate-pulse bg-amber-500',
          phase === 'speaking' && 'animate-pulse bg-blue-500',
          phase === 'thinking' && 'animate-pulse bg-purple-500',
          phase === 'listening' && 'bg-green-500'
        )}
      />
      {VOICE_PHASE_LABELS[phase]}
    </output>
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
  const { isSpeaking, sendSoftStop, primeAudioContext, beginBargeIn, endBargeIn } =
    useVoicePlayback({
      sessionId,
      enabled: voiceModeOn,
    });
  const handleFinalTranscript = useCallback(
    (text: string) => onFinalTranscript(text, { voiceMode: true }),
    [onFinalTranscript]
  );

  const { isCapturing, isConnecting, error, start, stop } = useMicCapture({
    onFinalTranscript: handleFinalTranscript,
    running,
    onSoftStop: sendSoftStop,
    onSpeechDetected: beginBargeIn,
    onSpeechEnded: endBargeIn,
    utteranceEndMs: config?.utteranceEndMs,
    bargeInSustainedMs: config?.bargeInSustainedMs,
  });

  useEffect(() => {
    return () => stop();
  }, [stop]);

  const isThinking = Boolean(running) && !isSpeaking;
  const phase = derivePhase(isConnecting, isCapturing, isSpeaking, isThinking);

  // Subtle cue the instant a captured utterance is sent and the agent starts
  // working, for a user who's looked away from the screen — specifically the
  // Listening→Thinking edge, not Connecting→Thinking or Speaking→Thinking,
  // both of which are common and would make the cue noisy/meaningless.
  // Always on whenever voice mode is on; no separate mute toggle.
  const prevPhaseRef = useRef<VoiceBadgePhase>('off');
  useEffect(() => {
    if (prevPhaseRef.current === 'listening' && phase === 'thinking') {
      playSound('sounds/voice-thinking-start.mp3', { volume: 0.3 });
    }
    prevPhaseRef.current = phase;
  }, [phase]);

  // Lets WorkspaceNotificationManager (mounted once at the app root, with no
  // other view into this component) suppress the workspace-complete chime
  // while voice mode is on — the agent's response is already spoken aloud,
  // so the chime is a redundant, jarring second notification on top of it.
  // The cleanup fires "false" both on toggle-off and on unmount (e.g.
  // navigating away mid-session), so the suppression can never get stuck on.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('voice-mode-changed', { detail: { active: isCapturing } })
    );
    return () => {
      window.dispatchEvent(new CustomEvent('voice-mode-changed', { detail: { active: false } }));
    };
  }, [isCapturing]);

  useEffect(() => {
    if (error) {
      toast.error(error);
      // start() failed after we optimistically flipped this on — make sure
      // playback doesn't stay "enabled" for a capture session that never started.
      setVoiceModeOn(false);
    }
  }, [error]);

  // An admin can disable voice mode or remove its API key while a workspace
  // is open. Without this, the toggle just disappears (the early return
  // below) while an active mic and /voice connection keep running with no
  // visible control to stop them.
  const voiceModeAvailable = Boolean(config?.enabled && config.hasApiKey);
  useEffect(() => {
    if (config !== undefined && !voiceModeAvailable && (isCapturing || isConnecting)) {
      stop();
      setVoiceModeOn(false);
    }
  }, [config, voiceModeAvailable, isCapturing, isConnecting, stop]);

  const handleClick = useCallback(() => {
    if (isCapturing || isConnecting) {
      // Also cancels a still-connecting attempt rather than leaving the
      // user stuck on "Connecting…" with no way out.
      stop();
      setVoiceModeOn(false);
    } else {
      // Synchronously inside the click gesture — see primeAudioContext's
      // definition for why this can't happen later in an effect.
      primeAudioContext();
      setVoiceModeOn(true);
      void start();
    }
  }, [isCapturing, isConnecting, start, stop, primeAudioContext]);

  if (!voiceModeAvailable) {
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
        // An active or connecting capture must stay clickable regardless of
        // `disabled`/`sessionId` — it's the only control that calls stop(),
        // and losing the chat connection (or session id) must not strand
        // the mic running with no way to turn it off. Reserve the disabled
        // state for starting a new session.
        disabled={!(isCapturing || isConnecting) && (disabled || !sessionId)}
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
      <VoiceStatusBadge phase={phase} />
    </div>
  );
}
