/**
 * Voice Narration Service
 *
 * Bridges the existing ACP session event stream to Deepgram TTS for voice
 * mode. Registers as a second, independent listener on `sessionEventBus` —
 * the same transport-free bus `ChatConnectionRegistry` already consumes for
 * chat delivery — so nothing about how those events are produced or
 * delivered to the chat WebSocket changes.
 *
 * Two invariants keep this additive rather than a shared-fate risk with the
 * chat delivery path documented in docs/design-voice-mode.md §7.1:
 * 1. The event handler never throws past its own boundary (fail closed).
 * 2. Sessions with no registered voice connection are an O(1) no-op, checked
 *    before any other work.
 *
 * Selective narration (docs/design-voice-mode.md §2.3): reasoning
 * (`thinking_delta`) is spoken clause-by-clause, but only when nothing is
 * already being spoken for that session — a clause arriving mid-utterance is
 * dropped rather than queued, so the narration never falls behind into a
 * backlog. The moment the agent's final answer starts streaming, any
 * in-flight thinking utterance is cut short (Deepgram's own `Clear` control
 * message) and narration switches to the final answer.
 *
 * The final answer is narrated the same clause-by-clause way, not
 * accumulated silently and spoken all at once at turn-complete — for a long
 * response that reads as a multi-second dead-air gap followed by a wall of
 * speech, which doesn't feel like a conversation. Unlike thinking, final-
 * answer clauses are never dropped: they're queued (`finalClauseQueue`) and
 * drained one at a time as the current narration finishes, since a dropped
 * word here would mean the agent's actual answer is missing content rather
 * than missing some reasoning color commentary.
 */

import WebSocket from 'ws';
import { safeSend } from '@/backend/lib/websocket-send';
import { cryptoService } from '@/backend/services/crypto.service';
import { createLogger } from '@/backend/services/logger.service';
import {
  SESSION_OUTBOUND_EVENT,
  type SessionOutboundEvent,
  sessionEventBus,
} from '@/backend/services/session/service/session-event-bus';
import { userSettingsService } from '@/backend/services/settings';
import type { VoiceServerMessage } from '@/shared/websocket/voice-message.schema';

const logger = createLogger('voice-narration');

const DEEPGRAM_TTS_URL = 'wss://api.deepgram.com/v1/speak';
const TTS_ENCODING = 'linear16';
const TTS_SAMPLE_RATE = 24_000;

/** Sentence-ending punctuation followed by whitespace or end of buffer. */
const CLAUSE_BOUNDARY_PATTERN = /[.!?](?:\s|$)/;
/** Cut an unpunctuated thought here so it can't buffer forever. */
const MAX_CLAUSE_LENGTH = 220;
/** Below this, keep buffering rather than speaking a fragment like "Ok." */
const MIN_CLAUSE_LENGTH = 12;

type NarrationKind = 'thinking' | 'final';

interface ActiveNarration {
  socket: WebSocket;
  kind: NarrationKind;
}

interface TurnState {
  /** Final-answer text received but not yet split into a complete clause. */
  finalTextBuffer: string;
  /** Complete final-answer clauses waiting their turn to be spoken, in order. */
  finalClauseQueue: string[];
  thinkingBuffer: string;
  /** True once this turn's final answer has started streaming. */
  suppressThinking: boolean;
  activeTts: ActiveNarration | null;
}

function createTurnState(): TurnState {
  return {
    finalTextBuffer: '',
    finalClauseQueue: [],
    thinkingBuffer: '',
    suppressThinking: false,
    activeTts: null,
  };
}

function extractClause(buffer: string): { clause: string; remainder: string } | null {
  const match = buffer.match(CLAUSE_BOUNDARY_PATTERN);
  if (match?.index !== undefined) {
    const end = match.index + match[0].length;
    const clause = buffer.slice(0, end).trim();
    if (clause.length >= MIN_CLAUSE_LENGTH) {
      return { clause, remainder: buffer.slice(end) };
    }
    return null;
  }
  if (buffer.length >= MAX_CLAUSE_LENGTH) {
    const lastSpace = buffer.lastIndexOf(' ', MAX_CLAUSE_LENGTH);
    const end = lastSpace > MIN_CLAUSE_LENGTH ? lastSpace : MAX_CLAUSE_LENGTH;
    return { clause: buffer.slice(0, end).trim(), remainder: buffer.slice(end) };
  }
  return null;
}

/**
 * Strips Markdown syntax before handing text to Deepgram, which otherwise
 * speaks the literal punctuation (e.g. "**bold**" comes out as "star star
 * bold star star") — the agent's messages are Markdown-formatted for the
 * chat UI, and voice narration reads that same raw stream.
 */
function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\w-]*\n?/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*\*|___)(.+?)\1/g, '$2')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/(?<![\w_])_([^_\n]+)_(?!\w)/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Extracts thinking-delta text from a session_delta event, if that's what it is. */
function extractThinkingDelta(payload: SessionOutboundEvent['payload']): string | null {
  if (payload.type !== 'session_delta' || payload.data.type !== 'agent_message') {
    return null;
  }
  const inner = payload.data.data;
  if (inner.type !== 'stream_event') {
    return null;
  }
  const streamEvent = inner.event;
  if (!streamEvent || streamEvent.type !== 'content_block_delta') {
    return null;
  }
  const { delta } = streamEvent;
  return delta.type === 'thinking_delta' ? delta.thinking : null;
}

class VoiceNarrationService {
  private readonly connections = new Map<string, WebSocket>();
  private readonly turns = new Map<string, TurnState>();
  private readonly seqBySession = new Map<string, number>();
  private busListenerAttached = false;

  registerConnection(sessionId: string, ws: WebSocket): void {
    this.connections.set(sessionId, ws);
    this.turns.set(sessionId, createTurnState());
    this.seqBySession.set(sessionId, 0);
    this.attachBusListener();
  }

  unregisterConnection(sessionId: string): void {
    this.connections.delete(sessionId);
    this.turns.delete(sessionId);
    this.seqBySession.delete(sessionId);
  }

  private attachBusListener(): void {
    if (this.busListenerAttached) {
      return;
    }
    this.busListenerAttached = true;
    sessionEventBus.on(SESSION_OUTBOUND_EVENT, (event: SessionOutboundEvent) => {
      try {
        this.handleEvent(event);
      } catch (error) {
        logger.error('Voice narration handler failed; chat delivery is unaffected', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private handleEvent(event: SessionOutboundEvent): void {
    const ws = this.connections.get(event.sessionId);
    if (!ws) {
      return;
    }
    const turn = this.turns.get(event.sessionId);
    if (!turn) {
      return;
    }

    const { payload } = event;

    if (payload.type === 'session_delta' && payload.data.type === 'assistant_text_delta') {
      this.handleFinalTextDelta(event.sessionId, ws, turn, payload.data.text);
      return;
    }

    const thinkingText = extractThinkingDelta(payload);
    if (thinkingText !== null) {
      this.handleThinkingDelta(event.sessionId, ws, turn, thinkingText);
      return;
    }

    if (payload.type === 'session_delta' && payload.data.type === 'session_runtime_updated') {
      this.handleRuntimeUpdate(event.sessionId, ws, turn, payload.data.sessionRuntime.activity);
    }
  }

  private handleRuntimeUpdate(
    sessionId: string,
    ws: WebSocket,
    turn: TurnState,
    activity: 'WORKING' | 'IDLE'
  ): void {
    if (activity === 'WORKING') {
      turn.finalTextBuffer = '';
      turn.finalClauseQueue = [];
      turn.thinkingBuffer = '';
      turn.suppressThinking = false;
      return;
    }

    // Flush a trailing fragment that never reached a clause boundary (e.g.
    // the answer didn't end in sentence-ending punctuation) — unlike
    // thinking, this must still be spoken, not dropped.
    const trailing = turn.finalTextBuffer.trim();
    if (trailing.length > 0) {
      turn.finalClauseQueue.push(trailing);
      turn.finalTextBuffer = '';
    }
    if (turn.finalClauseQueue.length > 0) {
      logger.info('Turn complete, draining remaining final clauses', {
        sessionId,
        queueLength: turn.finalClauseQueue.length,
      });
      this.maybeStartNextFinalClause(sessionId, ws, turn);
    } else {
      logger.info('Turn complete with no remaining text — nothing to speak', { sessionId });
    }
  }

  private handleFinalTextDelta(
    sessionId: string,
    ws: WebSocket,
    turn: TurnState,
    text: string
  ): void {
    if (!turn.suppressThinking) {
      // First final-answer chunk this turn: the agent is done thinking, so cut
      // off any in-flight thinking narration and stop buffering more of it.
      turn.suppressThinking = true;
      turn.thinkingBuffer = '';
      if (turn.activeTts?.kind === 'thinking') {
        this.clearActiveNarration(sessionId, turn.activeTts);
        // Cancelling Deepgram's synthesis only stops *new* audio; chunks
        // already forwarded to the browser before this point are already
        // scheduled for local playback and would otherwise keep playing
        // underneath the final answer. Tell the client to drop them too.
        const clearMessage: VoiceServerMessage = { type: 'clear_playback' };
        safeSend(ws, JSON.stringify(clearMessage), logger, 'voice clear_playback');
      }
    }

    // Speak the final answer as it streams in, the same way thinking is
    // narrated — not accumulated silently until turn-complete, which for a
    // long response reads as dead air followed by a wall of speech.
    turn.finalTextBuffer += text;
    let extracted = extractClause(turn.finalTextBuffer);
    while (extracted) {
      turn.finalClauseQueue.push(extracted.clause);
      turn.finalTextBuffer = extracted.remainder;
      extracted = extractClause(turn.finalTextBuffer);
    }
    this.maybeStartNextFinalClause(sessionId, ws, turn);
  }

  /**
   * Starts the next queued final-answer clause if nothing is currently
   * speaking. Called both when new clauses are extracted and when a
   * narration finishes, so the queue drains itself without waiting for a
   * new incoming event once all the text has already streamed in.
   */
  private maybeStartNextFinalClause(sessionId: string, ws: WebSocket, turn: TurnState): void {
    if (turn.activeTts) {
      return;
    }
    const next = turn.finalClauseQueue.shift();
    if (next === undefined) {
      return;
    }
    void this.speakClause(sessionId, ws, turn, next, 'final');
  }

  private handleThinkingDelta(
    sessionId: string,
    ws: WebSocket,
    turn: TurnState,
    deltaText: string
  ): void {
    if (turn.suppressThinking || turn.activeTts) {
      // Either past the thinking phase for this turn, or already speaking —
      // drop the clause rather than let a backlog build up.
      return;
    }
    turn.thinkingBuffer += deltaText;
    const extracted = extractClause(turn.thinkingBuffer);
    if (!extracted) {
      return;
    }
    turn.thinkingBuffer = extracted.remainder;
    void this.speakClause(sessionId, ws, turn, extracted.clause, 'thinking');
  }

  private clearActiveNarration(sessionId: string, active: ActiveNarration): void {
    try {
      if (active.socket.readyState === WebSocket.OPEN) {
        active.socket.send(JSON.stringify({ type: 'Clear' }));
      }
    } catch (error) {
      logger.error('Failed to clear in-flight Deepgram TTS narration', {
        error: error instanceof Error ? error.message : String(error),
        sessionId,
      });
    }
  }

  private async speakClause(
    sessionId: string,
    ws: WebSocket,
    turn: TurnState,
    rawText: string,
    kind: NarrationKind
  ): Promise<void> {
    const settings = await userSettingsService.get();
    if (!(settings.voiceModeEnabled && settings.deepgramApiKeyEncrypted)) {
      logger.info('Skipping narration — voice mode disabled or no key configured', {
        sessionId,
        voiceModeEnabled: settings.voiceModeEnabled,
        hasApiKey: Boolean(settings.deepgramApiKeyEncrypted),
      });
      return;
    }
    const text = stripMarkdownForSpeech(rawText);
    if (!text) {
      this.maybeStartNextFinalClause(sessionId, ws, turn);
      return;
    }
    const apiKey = cryptoService.decrypt(settings.deepgramApiKeyEncrypted);

    const params = new URLSearchParams({
      model: settings.voiceTtsModel,
      encoding: TTS_ENCODING,
      sample_rate: String(TTS_SAMPLE_RATE),
      speed: String(settings.voiceTtsSpeed),
    });
    logger.info('Opening Deepgram TTS connection', {
      sessionId,
      kind,
      textLength: text.length,
      model: settings.voiceTtsModel,
      speed: settings.voiceTtsSpeed,
    });
    const ttsSocket = new WebSocket(`${DEEPGRAM_TTS_URL}?${params.toString()}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    const active: ActiveNarration = { socket: ttsSocket, kind };
    turn.activeTts = active;

    let chunkCount = 0;
    let byteCount = 0;

    await new Promise<void>((resolve) => {
      const finish = () => {
        logger.info('Finished Deepgram TTS narration', {
          sessionId,
          kind,
          chunkCount,
          byteCount,
        });
        ttsSocket.removeAllListeners();
        if (ttsSocket.readyState === WebSocket.OPEN) {
          ttsSocket.close();
        }
        if (turn.activeTts === active) {
          turn.activeTts = null;
        }
        resolve();
        // The queue must keep draining itself once text has stopped
        // streaming in — otherwise the last few clauses would wait
        // indefinitely for an event that's never coming.
        this.maybeStartNextFinalClause(sessionId, ws, turn);
      };

      ttsSocket.on('open', () => {
        try {
          ttsSocket.send(JSON.stringify({ type: 'Speak', text }));
          ttsSocket.send(JSON.stringify({ type: 'Flush' }));
        } catch (error) {
          logger.error('Failed to send text to Deepgram TTS', {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
          finish();
        }
      });

      ttsSocket.on('message', (data: Buffer, isBinary: boolean) => {
        if (!this.connections.has(sessionId)) {
          finish();
          return;
        }
        if (isBinary) {
          chunkCount += 1;
          byteCount += data.length;
          this.forwardAudioChunk(sessionId, ws, data);
          return;
        }
        const message = this.parseControlMessage(data);
        logger.info('Deepgram TTS control message', { sessionId, message });
        this.handleTtsControlMessage(ttsSocket, message, finish);
      });

      ttsSocket.on('error', (error) => {
        logger.error('Deepgram TTS connection error', { error: error.message, sessionId });
        finish();
      });

      ttsSocket.on('close', finish);
    });
  }

  /** Handles Deepgram's Flushed (utterance complete) and Cleared (interrupted) control messages. */
  private handleTtsControlMessage(
    ttsSocket: WebSocket,
    message: { type: string } | null,
    finish: () => void
  ): void {
    if (message?.type === 'Flushed') {
      try {
        ttsSocket.send(JSON.stringify({ type: 'Close' }));
      } catch {
        // Connection is already going away; finish() closes it regardless.
      }
      finish();
    } else if (message?.type === 'Cleared') {
      // Interrupted mid-utterance (thinking cut short by the final answer).
      finish();
    }
  }

  private parseControlMessage(data: Buffer): { type: string } | null {
    try {
      const parsed = JSON.parse(data.toString('utf8'));
      return parsed && typeof parsed === 'object' && typeof parsed.type === 'string'
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  private forwardAudioChunk(sessionId: string, ws: WebSocket, data: Buffer): void {
    const seq = (this.seqBySession.get(sessionId) ?? 0) + 1;
    this.seqBySession.set(sessionId, seq);
    const message: VoiceServerMessage = {
      type: 'audio_chunk',
      data: data.toString('base64'),
      seq,
    };
    safeSend(ws, JSON.stringify(message), logger, 'voice audio chunk');
  }
}

export const voiceNarrationService = new VoiceNarrationService();
