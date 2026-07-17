# ACP Assistant Text Deltas Design

## Problem

ACP `agent_message_chunk` updates contain only newly generated assistant text, but `AcpEventProcessor` currently appends each chunk to an in-memory string and broadcasts the complete accumulated assistant message after every chunk. A response split into `n` equal chunks therefore sends approximately `(n + 1) / 2` final-message equivalents. The same hot path linearly scans and sorts the backend transcript, while the client scans its transcript and rebuilds renderer indexes on every replacement.

The accumulator also survives prompt completion until a non-assistant agent message arrives. Two tool-free prompt turns can therefore reuse the same order and append the second answer to the first.

## Considered Approaches

1. Add a dedicated offset-based `assistant_text_delta` event and coalesce it on the server. This is the selected approach because it makes the live/persisted distinction explicit, provides idempotence, reduces network text to linear growth, and preserves existing full-message replay behavior.
2. Reuse `agent_message` with a `content_block_delta` stream event. This avoids a new top-level event but overloads a payload whose current persistence guard deliberately discards text stream fragments, does not carry a stable message identifier, and makes live-only behavior less clear.
3. Keep cumulative server payloads and coalesce only in the browser transport. This reduces reducer commits but leaves serialization and WebSocket bytes quadratic, so it does not meet the primary requirement.

## Protocol and Server Streaming

Add `assistant_text_delta` to the shared WebSocket/session-delta union with four required fields:

- `messageId`: the stable backend transcript identifier, `${sessionId}-${order}`.
- `order`: the stable transcript order allocated for the current assistant text block.
- `text`: only the new coalesced text.
- `offset`: the UTF-16 string offset where `text` begins in the authoritative message.

`AcpEventProcessor` retains the complete accumulated text for persistence. Every inbound non-empty chunk updates the transcript immediately, so a snapshot or replay requested between live flushes contains the complete current assistant message. Separately, it appends the chunk to a pending broadcast buffer. The first pending chunk schedules one 25 ms timer. The timer emits one `assistant_text_delta` with the buffer's starting offset and clears only the pending broadcast buffer.

Text block boundaries flush synchronously before later events are emitted. Non-assistant agent messages, prompt success, prompt failure, the beginning of a new prompt, and session teardown all close the current block. This preserves transcript and display order across assistant text, tool calls, tool results, and turn completion while ensuring no pending text exceeds the selected flush interval.

Empty or malformed assistant chunks remain ignored. Timer callbacks verify that their captured stream state is still current before broadcasting, preventing a stale callback from affecting a later block.

## Backend Transcript Index

`SessionStore` gains a `transcriptIdToIndex` map. Registry creation initializes it, transcript replacement rebuilds it, and append paths add the new identifier. Replacing a message with the same stable identifier uses the map and does not sort because its order cannot change. Removing a message reindexes the shifted suffix; removal is not on the streaming hot path.

The transcript array remains authoritative and order-sorted. Snapshot/replay APIs continue to return full `ChatMessage` objects. No live-only delta is persisted to disk or included in replay batches.

## Client State and Delta Reconciliation

`ChatState` gains `agentMessageOrderToIndex`. Normal insertion, snapshot, replay, and renderer-window trimming rebuild it together with the existing tool index. Live text extension uses the order map, verifies the stable identifier and order, shallow-copies only the target message path, and does not call the renderer trim/index rebuild path.

When no message exists, a delta with offset zero creates a normal assistant text message using `messageId`; a delta with a forward gap is ignored until authoritative replay repairs state. For an existing text message:

- `offset === currentText.length`: append the complete delta.
- `offset < currentText.length` with matching overlap: append only the unseen suffix, or ignore it when fully duplicated.
- `offset > currentText.length`: ignore the forward gap.
- Conflicting overlap, identifier mismatch, negative offset, empty text, or a non-text target: ignore the delta.

These rules make duplicate and stale overlapping delivery idempotent without maintaining an unbounded out-of-order buffer. WebSocket delivery is ordered in normal operation; reconnect replay remains the recovery mechanism for missing prefixes.

Existing Markdown rendering is preserved because the reducer constructs the same `AgentMessage` assistant text shape used today. Tool streaming, queued messages, snapshots, and replay continue through their existing action paths.

## Renderer Window

`trimTranscriptForRenderer` first checks whether input is already ordered. When it is ordered and below the limit, it returns the input without cloning or sorting. When sorting or trimming is required, it keeps the existing safe-window behavior. `buildSnapshotMessages` explicitly clones the selected transcript before appending queued messages so the fast path cannot mutate the authoritative store.

## Error Handling and Edge Cases

- Many tiny chunks produce at most one broadcast per 25 ms window and transmit each generated text segment once.
- Reconnect before a pending flush receives the current complete message from the transcript.
- A tool boundary flushes pending text before the tool event and allocates later orders normally.
- Multiple assistant blocks separated by tools receive distinct orders and identifiers.
- Prompt completion closes tool-free responses, preventing cross-turn concatenation.
- Session teardown clears timers after synchronously flushing pending visible text.
- Duplicate, stale, overlapping, conflicting, and forward-gap deltas never duplicate or corrupt client text.
- Renderer-window trimming and queued-message ordering remain unchanged at and above the transcript limit.

## Testing

- Add backend fake-timer tests for 200 chunks, linear emitted text bytes, the 25 ms bound, complete persistence before flush, multiple blocks, tool boundaries, prompt completion, and timer cleanup.
- Add transcript-store tests for indexed replacement without reorder plus index maintenance across insertion, removal, and replacement.
- Add protocol/transport tests for direct and nested `assistant_text_delta` validation and action creation.
- Add reducer tests for first-delta creation, many deltas, Markdown content shape, duplicate/overlap/gap/conflict handling, replay interaction, tools, and queued messages.
- Add renderer/replay tests for the ordered fast path, safe trimming, non-mutation, and full in-progress assistant replay.
- Run focused red-green cycles, then `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`.
