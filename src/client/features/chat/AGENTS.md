# Chat feature

The client side of one agent session's chat: the WebSocket connection, frame
validation and load hydration, reducer state, the transcript surface and the
composer. The [features guide](../AGENTS.md) covers barrels and shared code.
Bare file names below are in this directory; paths that start with `src/` are
from the repository root.

## Owns, and does not own

This directory wires and resets replay reassembly (the assembler is
`src/shared/acp-protocol/protocol/replay-framing.ts`), owns client frame
validation, load requests and their retries, the chat reducer and its
stream-delta coalescing, pending sends, transcript grouping and windowing, the
`ChatTranscript` surface (viewport, virtualizer, scroll intent, keyed positions,
jump control, thinking footer), the composer (`chat-input/`) and the message and
tool renderers (`agent-activity/`). It does not own:

- What the server sends, replays and publishes: `src/backend/services/session/`,
  and socket delivery in `src/backend/routers/websocket/`.
- Wire schemas and replay framing: `src/shared/acp-protocol/protocol/`.
- Main chat composition, its transcript readiness and the error strip's actions:
  `src/client/routes/projects/workspaces/`.
- Quick chat: `src/client/features/kanban/`. Sub-agent transcripts:
  `src/client/features/subagents/`. Saved main-chat positions and closed-session
  transcripts: `src/client/features/workspace/`.
- Remembered disclosure choices:
  `src/client/hooks/use-remembered-disclosure.ts`.

## Public surface

The barrel is `index.ts`. Callers in routes and other features must:

- Give `ChatTranscript` a `scroll` identity of workspace, session and surface,
  with visibility, hydration readiness and optional position persistence, and
  add no message-count scroll effects or composer-height scroll writes.
- Send through `useTranscriptSend`, which asks the transcript to follow again.
- Keep `ChatTranscript` and `ChatInput` props identity-stable: memoize derived
  lists, callbacks and `leadingControls`, never inline JSX.
- Replace the message array and each changed message on an edit:
  `useGroupedChatMessages` detects appends and truncation by length and misses
  same-length in-place edits.

## Invariants

- Every server frame passes through `readChatFrame` once, after replay chunks
  are reassembled; an invalid frame reaches neither load bookkeeping nor the
  reducer, and a replay batch applies only its valid events.
  `use-chat-websocket.integration.test.tsx`.
- A correlated 413 or 409 load error ends loading without a retry and leaves the
  controls unhydrated. `use-chat-websocket.integration.test.tsx`.
- `useChatState` sends every reducer action through the stream-delta coalescer,
  and any other action, a disconnect or unmount first forwards buffered deltas.
  `stream-delta-coalescer.test.ts`,
  `use-chat-state.stream-coalescing.integration.test.tsx`.
- No delta waits longer than one 100 ms window in a foreground tab (hidden tabs
  drain at their throttled timer rate), and a batch reaches the state that
  dispatching each delta would. `stream-delta-coalescer.test.ts`.
- A targeted delta replaces the queue, committed entry or pending request it
  carries, matching what a snapshot would show.
  `reducer/session-state-delta.test.ts`.
- A local send stays in the transcript as Sending through snapshots and replay
  until the server reports its ID. `reducer/pending-sends.test.ts`,
  `transcript-rows.sending.test.tsx`.
- A thinking delta changes neither the preview nor the transcript when its order
  is below the latest thinking order or not above the last accepted delta's, so
  only a block's first delta may share the block's start order.
  `reducer/thinking.test.ts`.
- Typing in the composer does not re-render `ChatTranscript`, and streaming does
  not re-render `ChatInput`.
  `src/client/routes/projects/workspaces/workspace-detail-chat-content.render.test.tsx`,
  `src/client/routes/projects/workspaces/workspace-detail-chat-content.composer-render.test.tsx`.
- Layout changes and scroll events without wheel, key, touch or scrollbar input
  never change scroll intent; only that input, the jump controls, a send's
  follow request and activation from a saved position do.
  `transcript-scroll-events.test.ts`, `transcript-scroll-controller.test.ts`.
- A suspended or disposed scroll controller runs no pending frame and persists
  no position. `transcript-scroll-controller.test.ts`.
- The thinking footer stays mounted outside the transcript viewport as work
  starts and stops. `chat-transcript.test.tsx`.

## Map

- `use-chat-websocket.ts`: the socket, `load_session` requests, retries and the
  hydration guard. `chat-frame-diagnostics.ts` validates and reports frames.
- `use-chat-transport.ts`: unwraps `session_delta` and maps every event, live or
  replayed, to an action through `reducer/websocket-actions.ts`.
- `use-chat-state.ts`: state, sends, queue and drafts, behind
  `stream-delta-coalescer.ts`. `chat-session-provider.tsx` shares it.
- `reducer/`: `chatReducer` and its `slices/`; `renderer-indexes.ts` trims the
  recent renderer window and keeps its lookups.
- `use-grouped-chat-messages.ts`, `incremental-chat-grouping.ts`: cached tool
  grouping.
- `chat-transcript.tsx`: the surface; `transcript-layout.tsx` builds rows and
  `transcript-rows.tsx` renders them.
- `use-transcript-scroll.ts`: the virtualizer, suspended while hidden, zero-size
  or hydrating. `transcript-scroll-controller.ts`: intent and restore lifecycle.
  `transcript-scroll-events.ts`: user input and native writes.
  `transcript-scroll-position.ts`: keyed row offsets.
- `thinking-footer.tsx`, `thinking-preview.ts`: the reserved footer and its text
  cleanup. `agent-error-strip.tsx`: the pinned runtime error.
- [Streaming Markdown](../../../../docs/performance/streaming-markdown.md): how
  the live reply renders.

## Checks

- `pnpm test:e2e:scroll` drives the real virtualizer against the
  `/__transcript-scroll` fixture
  (`src/client/routes/transcript-scroll-fixture.tsx`). Run it when
  `@tanstack/react-virtual` changes: `transcript-scroll-events.ts` classifies
  native writes by their options, never by `isTrusted` or a one-frame
  programmatic flag. It does not replace a check on an iOS device.
- `pnpm exec playwright test --config=playwright.chat.config.ts` covers composer
  growth, queued-message actions and jump-button reachability in Storybook.

## Decisions

- [Chat frames are validated in full](../../../../docs/decisions/2026-11-13-chat-frames-are-validated-in-full.md)
- [Targeted session-state deltas](../../../../docs/decisions/2026-11-13-targeted-session-state-deltas.md)
- [Message rows offer no rewind](../../../../docs/decisions/2026-11-13-message-rows-offer-no-rewind.md)
