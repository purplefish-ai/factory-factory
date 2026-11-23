# Chat metadata a viewer holds is acknowledged per viewer

## Context

Every `load_session` ends with a `config_options_update` and a `slash_commands`
delta. On a real install they measured 20,865 and 42,340 bytes, and a phone
reconnects, and so loads again, each time it resumes. The content rarely
changes, and sessions often share it.

## Decision

The chat transport attaches a content digest (`v1:` and a SHA-256 of the
serialized delta) to each of these deltas of 1 KiB or more. The client keeps the
latest eight in memory for the tab and offers their digests in `load_session` as
`cachedMetadata`. The transport then sends a viewer that offered the digest a
`cached_metadata` acknowledgement in place of the delta, and the client replaces
the acknowledgement with its copy before the reducer sees it.

- The decision is per viewer, in `ChatConnectionRegistry`, not in the load
  service: load deltas are broadcast to every viewer of the session, and only
  the transport knows what each one offered. A second tab that offered nothing
  still receives the payload.
- The digest covers content only, so it matches across sessions, providers and
  server restarts, and changed content always goes out whole.
- An acknowledgement resolves only against the entries the client offered on
  that connection, copied when it connected, so eviction cannot lose one. A
  `load_session` is therefore never queued for a later socket.

## Consequences

- An unchanged reconnect receives about 300 bytes of acknowledgements instead of
  the payloads; the first load of new content carries 58 more bytes for the
  digest.
- The slash commands an alive session's replay carries are not digested: replay
  events stay unchanged.
- A later `load_session` extension adds named, optional fields beside
  `cachedMetadata`; a new digest scheme changes the prefix and only misses.
- The tests that hold this:
  `src/backend/routers/websocket/chat-load.handler.test.ts` and
  `chat-chunk-delivery.test.ts` beside it for the transport;
  `src/client/features/chat/use-chat-websocket.cached-metadata.integration.test.tsx`
  and `chat-cached-metadata.test.ts` beside it for the client.
