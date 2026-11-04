import { useCallback, useEffect, useMemo, useRef } from 'react';
import { type ChatMessage, QUEUED_MESSAGE_ORDER_BASE } from '@/lib/chat-protocol';
import type { ChatAction, ChatState } from './reducer';

export interface TranscriptHistoryControls {
  status: ChatState['transcriptHistory']['status'];
  enabled?: boolean;
  error?: string;
  loadOlder: () => void;
}

interface Options {
  sessionId: string | null;
  enabled: boolean;
  messages: ChatMessage[];
  history: ChatState['transcriptHistory'];
  dispatch: React.Dispatch<ChatAction>;
  fetchPage: (
    input: { sessionId: string; beforeMessageId: string },
    signal: AbortSignal
  ) => Promise<{ messages: ChatMessage[]; hasMore: boolean }>;
}

/** Lazy requests bypass the query cache; the reducer owns retained history. */
export function useTranscriptHistory(options: Options): TranscriptHistoryControls {
  const latest = useRef(options);
  latest.current = options;
  const inFlight = useRef<{
    requestId: string;
    history: Options['history'];
    controller: AbortController;
    sessionId: string;
    timeout?: ReturnType<typeof setTimeout>;
  } | null>(null);
  const { sessionId, enabled, dispatch } = options;
  useEffect(() => {
    const cancel = () => {
      const request = inFlight.current;
      if (!request || request.sessionId !== sessionId) {
        return;
      }
      inFlight.current = null;
      clearTimeout(request.timeout);
      request.controller.abort();
      dispatch({
        type: 'TRANSCRIPT_HISTORY_FAILED',
        requestId: request.requestId,
        error: 'Loading earlier messages was interrupted. Please retry.',
      });
    };
    if (!enabled) {
      cancel();
    }
    return cancel;
  }, [sessionId, enabled, dispatch]);

  const loadOlder = useCallback(() => {
    const current = latest.current;
    if (
      !(current.enabled && current.sessionId) ||
      current.history.status === 'complete' ||
      current.history.status === 'loading' ||
      inFlight.current?.history === current.history
    ) {
      return;
    }
    const first = current.messages.find(
      (message) =>
        (message.message?.type === 'session_lifecycle' || message.order >= 0) &&
        message.order < QUEUED_MESSAGE_ORDER_BASE
    );
    if (!first) {
      return;
    }
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    inFlight.current?.controller.abort();
    clearTimeout(inFlight.current?.timeout);
    const request: NonNullable<typeof inFlight.current> = {
      requestId,
      history: current.history,
      controller,
      sessionId: current.sessionId,
    };
    inFlight.current = request;
    current.dispatch({ type: 'TRANSCRIPT_HISTORY_START', requestId, beforeMessageId: first.id });
    request.timeout = setTimeout(() => controller.abort(), 30_000);
    void current
      .fetchPage({ sessionId: current.sessionId, beforeMessageId: first.id }, controller.signal)
      .then((page) => {
        if (inFlight.current === request) {
          current.dispatch({ type: 'TRANSCRIPT_HISTORY_LOADED', requestId, ...page });
        }
      })
      .catch((error: unknown) => {
        if (inFlight.current === request) {
          current.dispatch({
            type: 'TRANSCRIPT_HISTORY_FAILED',
            requestId,
            error: error instanceof Error ? error.message : 'Could not load earlier messages.',
          });
        }
      })
      .finally(() => {
        clearTimeout(request.timeout);
        if (inFlight.current === request) {
          inFlight.current = null;
        }
      });
  }, []);

  const canLoad =
    options.enabled &&
    options.messages.some(
      (message) =>
        (message.message?.type === 'session_lifecycle' || message.order >= 0) &&
        message.order < QUEUED_MESSAGE_ORDER_BASE
    );
  return useMemo(
    () => ({
      status: options.history.status,
      enabled: canLoad,
      error: options.history.status === 'error' ? options.history.error : undefined,
      loadOlder,
    }),
    [options.history, canLoad, loadOlder]
  );
}
