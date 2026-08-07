# Voice Mode: Audio Cues & Stop-Speaking Sensitivity — Design Doc

## Goal

Three improvements to voice mode (`src/client/features/voice/`, built on top of
[docs/design-voice-mode.md](../../design-voice-mode.md)):

1. The workspace-complete chime ("thinking is done" sound, currently
   `workspace-complete.mp3`) must be fully suppressed while voice mode is on —
   no gaps.
2. Play a new, subtle sound the moment voice mode transitions from
   **Listening** to **Thinking**, so a user who has looked away from the
   screen knows their utterance was captured and sent without having to watch
   the status badge. Always on whenever voice mode is on — no separate mute
   toggle.
3. Expose admin controls for two independently-tunable "aggressiveness" knobs
   voice mode currently hardcodes: how long a pause before it decides the
   user is done talking (turn-ending), and how quickly it decides the user
   has started talking over the agent's TTS (barge-in). Each control shows
   both its raw value and a simplified Aggressive/Balanced/Patient label.

## Current State

Voice mode has no explicit state machine. `VoiceStatusBadge`
(`voice-mode-toggle.tsx:55-90`) derives a label from four booleans on every
render, in priority order:

```
Connecting  >  Speaking  >  Thinking  >  Listening
```

- `isConnecting` / `isCapturing` — from `useMicCapture` (`use-mic-capture.ts:463-471`).
- `isSpeaking` — from `useVoicePlayback`, true while TTS audio is scheduled/playing.
- `isThinking` — **not a hook value**, computed inline at the call site:
  `voice-mode-toggle.tsx:221`: `isThinking={Boolean(running) && !isSpeaking}`,
  where `running` is the generic session-runtime phase, not voice-specific.

There is exactly one sound-playing call site in the whole client:
`playNotificationSound()` in `WorkspaceNotificationManager.tsx:82-95`, which
`new Audio()`s `public/sounds/workspace-complete.mp3` (the "owl hoot") at
volume 0.5. It fires from `sendWorkspaceNotification` whenever the backend
publishes a `workspace_notification_request` for a workspace whose sessions
all went idle (`chat-event-forwarder.service.ts:92-113` →
`use-chat-transport.ts:80-93` → a DOM `workspace-notification-request` event).

**Suppression exists but is client-side, single-tab-local, and doesn't
actually fix the common case.** `VoiceModeToggle` dispatches a
`voice-mode-changed` DOM CustomEvent keyed on `isCapturing`
(`voice-mode-toggle.tsx:141-148`); `WorkspaceNotificationManager` listens for
it into `voiceModeActiveRef` (`WorkspaceNotificationManager.tsx:17-30`) and
ANDs it into whether to play the chime (`WorkspaceNotificationManager.tsx:39-44`).

In practice a user hears the chime after nearly every turn while voice mode is
on. Two facts explain why:

1. The backend legitimately emits `request_notification` after **every
   individual turn**, not just when a whole workspace goes fully idle:
   `markSessionIdle` (`activity.service.ts:113-131`) fires `workspace_idle`
   whenever a workspace's count of running sessions drops from 1 to 0, which
   happens at the end of each turn in the common one-session-per-workspace
   case. This part is by design and not itself a bug.
2. The broadcast is global and un-scoped: `chat-event-forwarder.service.ts:98-112`
   calls `sessionEventBus.publishToAllClients(...)` for *every* connected
   WebSocket client regardless of which workspace the notification is about
   (`chat-connection-registry.ts`'s `broadcastToAll`), and the client applies
   no `workspaceId` filter before dispatching the DOM event
   (`use-chat-transport.ts:80-93`). Suppression is a single boolean, local to
   one browser tab, fed only by that tab's own `VoiceModeToggle`. Any other
   open tab or window — a different workspace, a background tab, even the
   same workspace opened twice — has no visibility into "voice mode is active
   over there" and plays the chime regardless. There is no cross-tab channel
   (no `BroadcastChannel`, no `localStorage` event bridge) anywhere in this
   app today to give it one.

This is a much better fit for "every turn" than the narrow `isConnecting`
timing race a purely client-side reading of the code would suggest — see
[§1](#1-fully-suppress-the-completion-chime-during-voice-mode) for the fix.

There is no VAD-aggressiveness setting today. Two independent, hardcoded
detectors exist:

- **Turn-ending detection (server-side, Deepgram):** `utterance_end_ms: '1000'`,
  a literal in `createDeepgramSocket` (`use-mic-capture.ts:144`). Decides "the
  user has stopped speaking, send the turn."
- **Barge-in detection (client-side, RMS energy):** `RMS_THRESHOLD = 0.02`,
  `SUSTAINED_FRAMES_TO_TRIGGER = 2` in `voice-activity.ts:8-9`. Decides "the
  user has started talking over the agent's TTS, interrupt it." Gates
  `beginBargeIn`/`endBargeIn` (`voice-mode-toggle.tsx:113-129`) and the
  "Speaking" badge dot.

Both are in scope for requirement 3 — see [§3](#3-admin-controls-for-voice-aggressiveness).

The admin settings pattern to follow is `voiceTtsSpeed`
(`src/shared/deepgram-voices.ts:60-64` bounds constants →
`voice.trpc.ts:140-168` `updateConfig` with a Zod `.min().max()` → a shadcn
`Slider` with `onValueCommit` in `VoiceModeSection.tsx:224-250`), all stored
on the single `UserSettings` Prisma row
(`prisma/schema.prisma`, `Voice Mode Settings` block).

---

## 1. Fully suppress the completion chime during voice mode

### Fix: track voice-mode-active server-side, gate the emit at the source

A client-side fix can't close the cross-tab gap described above — there's no
existing channel for one browser tab to know another tab has voice mode on.
Move the suppression decision to the backend instead, where the workspace
identity and every connected client are already visible in one place.

`voiceNarrationService` (`src/backend/services/session/service/voice/voice-narration.service.ts`)
already tracks, per session, whether a `/voice` WebSocket connection is
currently open: `connections: Map<sessionId, WebSocket>`, populated by
`registerConnection`/`unregisterConnection` (`voice-narration.service.ts:202-239`,
called from `voice.handler.ts:43,75` on that socket's open/close). That
connection opens the instant `useVoicePlayback`'s `enabled` flips true — i.e.
`voiceModeOn` in `VoiceModeToggle`, set synchronously inside the click handler
(`voice-mode-toggle.tsx:181`), *before* `start()` even begins connecting to
Deepgram's STT. So this map already answers "is voice mode on for session X,"
and does so earlier than the `isCapturing`/`isConnecting` client signals this
draft originally proposed reading from — no gap to close on that axis either.

Add a query method:

```ts
// voice-narration.service.ts, alongside isCurrentConnection
hasActiveConnection(sessionId: string): boolean {
  return this.connections.has(sessionId);
}
```

In `chat-event-forwarder.service.ts`'s `setupWorkspaceNotifications`
(currently lines 92-113), resolve the workspace's sessions and skip the
broadcast entirely if voice mode is active on any of them:

```ts
this.workspace.on('request_notification', (data) => {
  const { workspaceId, workspaceName, sessionCount, finishedAt } = data;
  const publish = () =>
    sessionEventBus.publishToAllClients({
      type: 'workspace_notification_request',
      workspaceId,
      workspaceName,
      sessionCount,
      finishedAt: finishedAt.toISOString(),
    });

  sessionDataService
    .findAgentSessionsByWorkspaceId(workspaceId)
    .then((sessions) => {
      if (sessions.some((s) => voiceNarrationService.hasActiveConnection(s.id))) {
        logger.debug('Suppressing workspace notification: voice mode active', { workspaceId });
        return;
      }
      publish();
    })
    .catch((error) => {
      // This lookup runs on every turn for every workspace, voice or not —
      // a DB hiccup here must not silently swallow the notification for
      // non-voice users just because the new voice-suppression check failed
      // to resolve. Fail open: publish anyway.
      logger.error('Failed to check voice-active state; publishing notification anyway', error, {
        workspaceId,
      });
      publish();
    });
});
```

(`findAgentSessionsByWorkspaceId` already exists at
`session-data.service.ts:62-69`.)

**Drawback for the non-voice path:** this adds one DB read (a cheap, indexed
lookup against the small `AgentSession` table) to every single turn
completion, for every workspace, whether or not that workspace ever uses
voice mode — previously this was a synchronous, in-memory, unfailable emit.
The fail-open `.catch` above bounds the risk to "notification is sent
slightly late" rather than "a DB error silently drops the sound for everyone
system-wide," and the query is cheap enough that added latency should be
negligible, but it's worth watching under load (many workspaces finishing
turns concurrently) since this is now a hot path with I/O it didn't have
before.

This fixes both failure modes the client-only approach couldn't reach in one
shot: a notification for the *wrong* workspace in the same tab is no longer
over-suppressed by a single global ref (the check is now genuinely per
workspace), and a notification reaching a *different* tab or window than the
one running voice mode is correctly silenced everywhere, because the decision
is made once, centrally, before the broadcast goes out, rather than
independently re-derived (and gotten wrong) by every client that receives it.

### What happens to the existing client-side mechanism

Keep `VoiceModeToggle`'s `voice-mode-changed` event and
`WorkspaceNotificationManager`'s `voiceModeActiveRef` as-is — they become
redundant-but-harmless defense in depth for the current tab (e.g. covering
the instant between the backend socket closing and this tab's own state
catching up) rather than the mechanism doing the real work. The
`isCapturing`-vs-`isConnecting` timing gap flagged in an earlier draft of this
doc is now moot: it no longer matters which of those two client booleans the
event is keyed on, since the backend check — sourced from `/voice` connection
registration, which predates both — is what actually fixes the bug.

No new setting, no new sound, no new Prisma model — this reuses state
`voiceNarrationService` already maintains for narration delivery.

**Testing:** add a test for `chat-event-forwarder.service.ts` mocking
`voiceNarrationService.hasActiveConnection` true/false and asserting
`sessionEventBus.publishToAllClients` is/isn't called for a `request_notification`
event on a workspace with an active voice session. Add an end-to-end-ish test:
open a `/voice` WS for a session, emit `request_notification` for that
session's workspace, assert no `workspace_notification_request` reaches a
mocked client; close the `/voice` connection and assert the next
`request_notification` for the same workspace *does* get published.

---

## 2. Subtle sound on Listening → Thinking

### Approach

Add a `useEffect` inside `VoiceModeToggle` that watches the same
`isConnecting`/`isCapturing`/`isSpeaking`/`isThinking` values already
assembled there (lines 190, 221) and diffs the *previous* rendered status
label against the current one, via a ref — mirroring how
`VoiceStatusBadge` already derives the label, so the two can never disagree
about what state the badge is showing:

```ts
type VoiceBadgePhase = 'connecting' | 'speaking' | 'thinking' | 'listening' | 'off';

function derivePhase(isConnecting: boolean, isCapturing: boolean, isSpeaking: boolean, isThinking: boolean): VoiceBadgePhase {
  if (!(isConnecting || isCapturing)) return 'off';
  if (isConnecting) return 'connecting';
  if (isSpeaking) return 'speaking';
  if (isThinking) return 'thinking';
  return 'listening';
}
```

`VoiceStatusBadge`'s inline label ternary (lines 69-75) should be rewritten in
terms of the same `derivePhase` helper so there is exactly one place that
decides what phase voice mode is in — otherwise the sound and the badge text
are two independent derivations of the same booleans that can drift apart
over time.

The transition to watch is specifically **`listening` → `thinking`** (not
`connecting` → `thinking`, not `speaking` → `thinking`, both of which are
common and would make the cue noisy/meaningless):

```ts
const prevPhaseRef = useRef<VoiceBadgePhase>('off');
useEffect(() => {
  const phase = derivePhase(isConnecting, isCapturing, isSpeaking, isThinking);
  if (prevPhaseRef.current === 'listening' && phase === 'thinking') {
    playSound('sounds/voice-thinking-start.mp3', { volume: 0.3 });
  }
  prevPhaseRef.current = phase;
}, [isConnecting, isCapturing, isSpeaking, isThinking]);
```

### Shared sound-playing utility

`playNotificationSound` is currently private to `WorkspaceNotificationManager.tsx`
and hardcodes its file path and volume. Per this repo's convention for
code shared by two features with no ownership relationship to either
(`AGENTS.md` — "Where shared client code goes"), extract it to
`src/client/lib/sound.ts`:

```ts
export function playSound(relativePath: string, opts?: { volume?: number }): void {
  try {
    const audio = new Audio(`${import.meta.env.BASE_URL}${relativePath}`);
    audio.volume = opts?.volume ?? 0.5;
    audio.play().catch(() => {});
  } catch {
    // Autoplay blocked or audio failed to load — non-critical, ignore.
  }
}
```

`WorkspaceNotificationManager.tsx:82-95` calls this instead of its own
`playNotificationSound`; `voice-mode-toggle.tsx` imports it directly (a
one-line React-agnostic utility with no feature ownership — `src/client/lib/`
per the same convention doc, not a `voice` barrel export, since `workspace`
also needs it and going through the `voice` barrel for a plain utility would
make an internal detail another feature's public API for one caller).

### New asset

`public/sounds/voice-thinking-start.mp3` — needs to be sourced or generated
(short, < 300ms, soft/non-jarring — a single soft tick or rising blip, not a
chime with sustain, so it doesn't compete with the user starting to talk
again immediately). Not part of this design doc's code changes; flagged as a
design/asset dependency before this ships. Suggest a CC0/royalty-free UI-tick
sound rather than reusing `workspace-complete.mp3`'s style, since the two
need to read as clearly different events (turn accepted vs. workspace fully
done).

### No dedicated on/off setting

Decided: no separate mute toggle. The cue always plays whenever voice mode is
active — it's gated entirely by the existing voice-mode toggle, not a second
switch. If product feedback later wants one, it follows the exact
`playSoundOnComplete` pattern already in `UserSettings`, but that's out of
scope here.

**Testing:** a `voice-mode-toggle.test.tsx` case driving `isCapturing`/`running`/
`isSpeaking` through a full Listening → Thinking → Speaking → Listening cycle
via rerender, asserting `playSound` (mocked) is called exactly once, on the
Listening→Thinking edge only.

---

## 3. Admin controls for voice aggressiveness

Two independent knobs, both currently hardcoded, both framed to the admin as
"aggressiveness": how long a pause before voice mode decides the user is
*done* talking (turn-ending), and how quickly it decides the user has
*started* talking over the agent's TTS (barge-in). Each gets its own slider,
each slider shows both its raw value and a computed
Aggressive/Balanced/Patient label — no separate persisted "preset" field,
the label is derived client-side from the raw value so the two can never
disagree.

```ts
// src/shared/voice-vad.ts (new) — shared by both sliders
export type VoiceAggressivenessLabel = 'Aggressive' | 'Balanced' | 'Patient';

export function deriveAggressivenessLabel(value: number, min: number, max: number): VoiceAggressivenessLabel {
  const fraction = (value - min) / (max - min);
  if (fraction <= 1 / 3) return 'Aggressive';
  if (fraction <= 2 / 3) return 'Balanced';
  return 'Patient';
}
```

### 3a. Stop-speaking sensitivity (turn-ending)

Deepgram's `UtteranceEnd` event (already the mechanism `attachTranscriptHandler`
uses to decide a turn is over, `use-mic-capture.ts:265-288`) fires
`utterance_end_ms` after the last word Deepgram heard. Lower = decides the
user stopped talking sooner (snappier turns, more likely to cut off someone
mid-sentence-pause). Higher = more patient, slower to respond, less likely to
cut someone off.

**Data model** — add to `UserSettings` in `prisma/schema.prisma`, in the
existing `// Voice Mode Settings (BYOK Deepgram)` block:

```prisma
voiceUtteranceEndMs   Int  @default(1000)  // Deepgram silence gap (ms) before a turn is considered done; lower = more aggressive
```

Default `1000` exactly matches today's hardcoded literal — zero behavior
change until an admin touches the control.

**Bounds** (`src/shared/voice-vad.ts`, alongside `deriveAggressivenessLabel`):

```ts
// Deepgram requires utterance_end_ms >= 1000; upper bound is a UX choice,
// not a Deepgram constraint — confirm the 1000 floor against current
// Deepgram docs before shipping, since nothing in the existing code cites it.
export const VOICE_UTTERANCE_END_MS_MIN = 1000;
export const VOICE_UTTERANCE_END_MS_MAX = 3000;
export const VOICE_UTTERANCE_END_MS_STEP = 250;
export const DEFAULT_VOICE_UTTERANCE_END_MS = 1000;
```

**tRPC** — extend `voice.trpc.ts`'s `getConfig`/`updateConfig`
(`voice.trpc.ts:113-121`, `140-168`) exactly like `ttsSpeed`:

```ts
// getConfig
utteranceEndMs: settings.voiceUtteranceEndMs,

// updateConfig input
utteranceEndMs: z.number().int().min(VOICE_UTTERANCE_END_MS_MIN).max(VOICE_UTTERANCE_END_MS_MAX).optional(),

// updateConfig mutation
voiceUtteranceEndMs: input.utteranceEndMs,
```

**Client wiring** — `utterance_end_ms` is a Deepgram *connection* parameter;
it only takes effect on the socket opened when capture starts, not
mid-utterance:

- `VoiceModeToggle` already holds `config` from `trpc.voice.getConfig.useQuery()`
  (line 108) — pass `config?.utteranceEndMs` into `useMicCapture`'s options
  (`voice-mode-toggle.tsx:123-129`).
- `UseMicCaptureOptions` (`use-mic-capture.ts:448-461`) gains `utteranceEndMs?: number`.
- Threaded through `start` → `attemptCapture` (`CaptureAttemptDeps`,
  `use-mic-capture.ts:349-355`) → `createDeepgramSocket(accessToken, utteranceEndMs)`,
  replacing the literal `'1000'` (`use-mic-capture.ts:144`) with
  `String(utteranceEndMs ?? DEFAULT_VOICE_UTTERANCE_END_MS)`.

A value changed mid-session takes effect on the *next* `start()` (next fresh
Deepgram socket) — same latency as `ttsSpeed`/`ttsModel` today.

### 3b. Barge-in sensitivity (interruption)

`SpeechActivityDetector` (`voice-activity.ts:23-52`) needs `SUSTAINED_FRAMES_TO_TRIGGER`
(currently `2`, module-level) consecutive loud PCM frames before it reports
speech and triggers `beginBargeIn`. Each frame is one `AudioWorkletNode.port`
message from `pcm-capture-processor.js`, posted once per Web Audio render
quantum — the browser-standard 128 samples — at the capture `AudioContext`'s
sample rate, which this app forces to `TARGET_SAMPLE_RATE` (16kHz,
`use-mic-capture.ts:6,382`). That makes frame duration a fixed, known
constant in this app (not device- or browser-variable): 128 / 16000 =
**8ms/frame**. `SUSTAINED_FRAMES_TO_TRIGGER = 2` today means ~16ms of
sustained loudness triggers barge-in.

Persist and expose this as **milliseconds**, not a raw frame count, so the
setting's meaning doesn't depend on an implementation detail (render quantum
size) leaking into the schema — convert ms → frames at runtime:

```ts
// use-mic-capture.ts, alongside TARGET_SAMPLE_RATE
const AUDIO_WORKLET_FRAME_MS = 8; // 128-sample render quantum @ 16kHz context rate
```

`RMS_THRESHOLD` (loudness threshold, not a duration) is **not** exposed —
there's no natural "seconds" framing for an amplitude value, and the sustained
-frame duration alone already captures the "how aggressively" question the
admin control is meant to answer. Flagged as a possible future second axis in
[Open Questions](#open-questions).

**Data model:**

```prisma
voiceBargeInSustainedMs   Int  @default(16)  // Sustained loud-frame duration (ms) before barge-in triggers; lower = more aggressive
```

Default `16` = `2 frames × 8ms`, matching today's hardcoded behavior exactly.

**Bounds** (`src/shared/voice-vad.ts`):

```ts
// 1 frame (8ms) is the floor — 0 sustained frames would trigger on any
// single loud sample, defeating the point of debouncing. Upper bound is a
// UX choice: past ~80ms (10 frames) barge-in starts to feel sluggish, the
// agent visibly keeps talking for a beat after the user starts.
export const VOICE_BARGE_IN_SUSTAINED_MS_MIN = 8;
export const VOICE_BARGE_IN_SUSTAINED_MS_MAX = 80;
export const VOICE_BARGE_IN_SUSTAINED_MS_STEP = 8;
export const DEFAULT_VOICE_BARGE_IN_SUSTAINED_MS = 16;
```

**tRPC** — same shape as 3a, `bargeInSustainedMs` added to `getConfig`/`updateConfig`.

**Client wiring:**

- `SpeechActivityDetector`'s constructor gains a `sustainedFramesToTrigger`
  parameter (default `2`, preserving current behavior for any caller that
  doesn't pass one — e.g. tests), used instead of the module constant:
  `constructor(private sustainedFramesToTrigger = 2) {}`, referenced in
  `observe()` in place of `SUSTAINED_FRAMES_TO_TRIGGER`.
- `attemptCapture` (`use-mic-capture.ts:437`) computes
  `Math.max(1, Math.round(bargeInSustainedMs / AUDIO_WORKLET_FRAME_MS))` and
  passes it: `new SpeechActivityDetector(sustainedFrames)`.
- Same config-threading path as 3a: `VoiceModeToggle` → `useMicCapture` options
  → `CaptureAttemptDeps` → `attemptCapture`.

Unlike 3a, this takes effect on the *next barge-in check*, not just next
`start()` — but since it's only read once at `attemptCapture` time to
construct the detector for that capture session, it has the same "changes
apply next time voice mode (re)starts" latency in practice.

### Admin UI

In `VoiceModeSection.tsx`, add both sliders after the existing Speed slider
(lines 224-250), each using the identical local-state + `onValueCommit` +
error-rollback pattern, each showing raw value and derived label together:

```tsx
<div className="space-y-1.5">
  <div className="flex items-center justify-between w-[280px]">
    <Label htmlFor="voice-utterance-end">Stop-speaking sensitivity</Label>
    <span className="text-xs text-muted-foreground font-mono">
      {(utteranceEndMs / 1000).toFixed(2)}s · {deriveAggressivenessLabel(utteranceEndMs, VOICE_UTTERANCE_END_MS_MIN, VOICE_UTTERANCE_END_MS_MAX)}
    </span>
  </div>
  <Slider
    id="voice-utterance-end"
    className="w-[280px]"
    value={[utteranceEndMs]}
    onValueChange={([value]) => setUtteranceEndMs(value ?? DEFAULT_VOICE_UTTERANCE_END_MS)}
    onValueCommit={([value]) =>
      updateConfig.mutate(
        { enabled, utteranceEndMs: value ?? DEFAULT_VOICE_UTTERANCE_END_MS },
        { onError: () => setUtteranceEndMs(config?.utteranceEndMs ?? DEFAULT_VOICE_UTTERANCE_END_MS) }
      )
    }
    min={VOICE_UTTERANCE_END_MS_MIN}
    max={VOICE_UTTERANCE_END_MS_MAX}
    step={VOICE_UTTERANCE_END_MS_STEP}
    disabled={updateConfig.isPending || !hasStoredKey}
  />
  <p className="text-xs text-muted-foreground">
    How long a pause before voice mode decides you've finished talking.
  </p>
</div>

<div className="space-y-1.5">
  <div className="flex items-center justify-between w-[280px]">
    <Label htmlFor="voice-barge-in">Barge-in sensitivity</Label>
    <span className="text-xs text-muted-foreground font-mono">
      {bargeInSustainedMs}ms · {deriveAggressivenessLabel(bargeInSustainedMs, VOICE_BARGE_IN_SUSTAINED_MS_MIN, VOICE_BARGE_IN_SUSTAINED_MS_MAX)}
    </span>
  </div>
  <Slider
    id="voice-barge-in"
    className="w-[280px]"
    value={[bargeInSustainedMs]}
    onValueChange={([value]) => setBargeInSustainedMs(value ?? DEFAULT_VOICE_BARGE_IN_SUSTAINED_MS)}
    onValueCommit={([value]) =>
      updateConfig.mutate(
        { enabled, bargeInSustainedMs: value ?? DEFAULT_VOICE_BARGE_IN_SUSTAINED_MS },
        { onError: () => setBargeInSustainedMs(config?.bargeInSustainedMs ?? DEFAULT_VOICE_BARGE_IN_SUSTAINED_MS) }
      )
    }
    min={VOICE_BARGE_IN_SUSTAINED_MS_MIN}
    max={VOICE_BARGE_IN_SUSTAINED_MS_MAX}
    step={VOICE_BARGE_IN_SUSTAINED_MS_STEP}
    disabled={updateConfig.isPending || !hasStoredKey}
  />
  <p className="text-xs text-muted-foreground">
    How quickly voice mode notices you've started talking over its spoken
    reply and stops to listen.
  </p>
</div>
```

**Testing:** extend `voice.trpc.test.ts` with `updateConfig`/`getConfig`
round-trip coverage for both new fields (mirroring the existing `ttsSpeed`
case), including min/max Zod rejection. Extend `use-mic-capture.test.ts` to
assert `createDeepgramSocket`'s query string carries the passed-through
`utteranceEndMs` (or the default when omitted), and that `attemptCapture`
constructs `SpeechActivityDetector` with the frame count derived from
`bargeInSustainedMs`. Extend `voice-activity.test.ts` to cover
`SpeechActivityDetector` constructed with a non-default
`sustainedFramesToTrigger` (e.g. `1`, to assert it triggers a beat sooner
than the current hardcoded `2`-frame behavior). Add a
`deriveAggressivenessLabel` unit test covering the three buckets and both
boundary fractions (`1/3`, `2/3`).

---

## Summary of changes

| Area | File | Change |
|---|---|---|
| Chime suppression: query method | `voice-narration.service.ts` | Add `hasActiveConnection(sessionId)` |
| Chime suppression: gate the emit | `chat-event-forwarder.service.ts` | Skip `publishToAllClients` when any session in the workspace has an active `/voice` connection |
| Shared sound util | `src/client/lib/sound.ts` (new) | Extract `playSound()` from `WorkspaceNotificationManager` |
| Chime call site | `WorkspaceNotificationManager.tsx` | Use `playSound()` instead of local `playNotificationSound` |
| Thinking-cue phase logic | `voice-mode-toggle.tsx` | Shared `derivePhase()` used by both the badge label and a new transition-watching effect |
| Thinking-cue asset | `public/sounds/voice-thinking-start.mp3` (new) | Needs sourcing — not code |
| VAD setting: bounds + label helper | `src/shared/voice-vad.ts` (new) | `VOICE_UTTERANCE_END_MS_*`, `VOICE_BARGE_IN_SUSTAINED_MS_*`, `deriveAggressivenessLabel()` |
| VAD setting: schema | `prisma/schema.prisma` | `voiceUtteranceEndMs Int @default(1000)`, `voiceBargeInSustainedMs Int @default(16)` on `UserSettings` |
| VAD setting: API | `voice.trpc.ts` | `utteranceEndMs`, `bargeInSustainedMs` on `getConfig`/`updateConfig` |
| VAD setting: UI | `VoiceModeSection.tsx` | Two new sliders, each showing raw value + derived label, same pattern as `ttsSpeed` |
| VAD setting: capture (turn-ending) | `use-mic-capture.ts` | Thread `utteranceEndMs` option → `createDeepgramSocket` |
| VAD setting: capture (barge-in) | `voice-activity.ts`, `use-mic-capture.ts` | `SpeechActivityDetector` takes `sustainedFramesToTrigger`; `attemptCapture` derives it from `bargeInSustainedMs` via `AUDIO_WORKLET_FRAME_MS` |

## Open Questions

1. **Should `RMS_THRESHOLD` (loudness, not duration) also become
   admin-configurable**, as a third slider alongside barge-in's sustained-
   frame duration? Deferred for now — there's no natural "seconds" framing
   for an amplitude value, and §3b's sustained-duration control already
   covers "how aggressively" for barge-in. Revisit if users report barge-in
   triggers on background noise (need a higher loudness floor) or misses
   quiet speech (need a lower one) in a way the duration slider alone can't
   fix.
2. **Confirm Deepgram's actual minimum for `utterance_end_ms`** (assumed
   1000ms here, matching the current hardcoded value and this feature's
   `interim_results`/`vad_events` prerequisites already set in
   `createDeepgramSocket`) against current Deepgram docs before implementation,
   since nothing in the existing code cites the constraint.
3. **Confirm the Web Audio render quantum is 128 samples** in every target
   runtime (assumed for §3b's `AUDIO_WORKLET_FRAME_MS = 8` derivation) — this
   is the de facto standard across current browser engines but isn't
   explicitly pinned anywhere in this codebase today.
4. **New sound asset sourcing/licensing** for `voice-thinking-start.mp3` needs
   an owner — not something this doc or its implementation PR can resolve in
   code.
