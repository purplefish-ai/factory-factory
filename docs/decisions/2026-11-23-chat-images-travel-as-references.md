# Chat images travel to browsers as references

## Context

Images reach a chat as base64: prompt attachments (up to 10 MB each, also
restored from provider history) and tool results such as screenshots. Every
`load_session` replays the transcript, and phones reconnect whenever the app
returns from the background, so each image was downloaded again on every resume,
on every session snapshot and in the live echo of the message that sent it. A 1
MB PNG cost 1.86 MB per load, because a replay event over the 128 KiB frame
limit is fragmented as base64 of its JSON.

## Decision

The chat transport (`src/backend/routers/websocket/`, and the earlier transcript
pages in `session.readTranscriptPage`) replaces image bytes with a reference
just before sending: the SHA-256 of the media type and base64, the decoded size
and, when the header gives them cheaply, the dimensions. Browsers load
`/api/chat-images/<id>` with immutable cache headers, so the HTTP cache keeps
each image and later loads send only the reference. The tab that sent an image
shows it from its own copy, and a referenced image is fetched back into base64
before it is sent again.

The bytes the endpoint serves are kept in an in-memory `ChatImageStore`,
registered whenever a reference is sent and bounded by a least-recently-used
character budget. Nothing new is stored and no stored bytes change: the session
store, provider history, `creationMetadata` and what the agent receives still
hold inline base64.

Rejected:

- A persisted image table or files on disk: new stored data and a migration, for
  bytes the provider history already holds.
- Externalizing in the session store: the store feeds prompts, history and
  archives, which must keep inline bytes.
- Resolving references on the server when a client resends one: the store may
  have evicted the image, while the browser's cache usually still has it.

## Consequences

- A reference outlives its store entry after a restart or eviction; the next
  load registers it again, and the image's failure state offers a retry.
- The endpoint applies the same Origin and DNS-rebinding `Host` checks as
  `publicProcedure`, which can already read every transcript with its images. It
  is stricter in one way: an `<img>` sends no `Origin`, so it also refuses
  `Sec-Fetch-Site: cross-site` and answers with
  `Cross-Origin-Resource-Policy: same-origin`. Only PNG, JPEG, GIF and WebP,
  typed from their bytes, are served, with `nosniff` and a sandbox policy.
- Sub-agent transcripts (raw ACP updates) and closed-session archives still
  carry inline images; both are read on demand rather than on every resume.
