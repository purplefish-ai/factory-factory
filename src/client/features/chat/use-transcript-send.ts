import { useCallback, useMemo, useState } from 'react';
import type { TranscriptScrollOptions } from './transcript-scroll.types';
import type { UseChatWebSocketReturn } from './use-chat-websocket';

/** Treat a local send as an explicit request to return to the live conversation. */
export function useTranscriptSend(
  send: UseChatWebSocketReturn['sendMessage'],
  scroll: TranscriptScrollOptions
) {
  const [request, setRequest] = useState<{ identity: string }>();
  const sendMessage = useCallback<UseChatWebSocketReturn['sendMessage']>(
    (text, options) => {
      send(text, options);
      setRequest({ identity: scroll.identity });
    },
    [send, scroll.identity]
  );
  const transcriptScroll = useMemo(
    () => ({
      ...scroll,
      ...(request?.identity === scroll.identity ? { followRequest: request } : {}),
    }),
    [scroll, request]
  );
  return { sendMessage, transcriptScroll };
}
